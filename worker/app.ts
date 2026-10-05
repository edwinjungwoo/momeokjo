import { Hono, type Context } from "hono";
import { z } from "zod";
import { MAX_RADIUS, MIN_RADIUS, isValidRadius } from "../shared/constants";
import { MAX_EVENT_BODY_BYTES, parseEventBatch } from "../shared/events";
import { HUBS, isHubId } from "../shared/hubs";
import type { PlacesResponse } from "../shared/types";
import { auditArea } from "./audit";
import { limitsFrom } from "./config";
import { meteredDb, overReadBudget, overWriteBudget, readSoftCap, recordD1Usage, type D1Usage } from "./d1Usage";
import { eventStats, insertEvents } from "./events";
import type { FetchFn } from "./fetchFn";
import { warmOnce } from "./maintenance";
import { getPlace, getPlaces, type ServiceDeps } from "./placesService";
import { placesBody, type PlacesMeta } from "./present";

/**
 * R12: 공개 목록 API는 거점 id와 50m 단위 반경만 받는다 (좌표는 서버가 shared/hubs.ts에서 찾는다).
 * R42: 반경은 검증만 하고, 서버는 언제나 거점의 1000m 목록을 계산·캐시한다 (화면이 거리로 거른다)
 */
export const PlacesQuery = z.object({
  hub: z.string().refine(isHubId),
  radius: z.coerce.number().refine(isValidRadius),
});

/** 관리용(warm/audit)만 임의 좌표를 받는다 */
export const AreaQuery = z.object({
  lat: z.coerce.number().min(33).max(39),
  lng: z.coerce.number().min(124).max(132),
  radius: z.coerce.number().int().min(MIN_RADIUS).max(MAX_RADIUS),
});

/** R36: 오늘/7일/30일 (KST, 오늘 포함), 전체 또는 거점 하나 */
export const StatsQuery = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
  hub: z.string().refine((h) => h === "all" || isHubId(h)).default("all"),
});

/** 카카오 장소 ID: 숫자만, 최대 15자리 */
export const PLACE_ID = /^\d{1,15}$/;

/** R35: 이벤트를 받는 화면 주소 — 운영 주소와 로컬 개발 주소(localhost·127.0.0.1의 아무 포트, 사내망 172.30.x.x의 Vite 5173) */
const EVENT_ORIGIN = /^(?:https:\/\/mmj\.itmz\.me|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?|http:\/\/172\.30\.\d{1,3}\.\d{1,3}:5173)$/;
/** Origin이 없으면(curl, 일부 오래된 브라우저) 받고, 있으면 위 주소일 때만 받는다 */
export const eventOriginAllowed = (origin: string | undefined): boolean => origin === undefined || EVENT_ORIGIN.test(origin);

/** R12 응답 캐시 (Workers Cache API의 일부). 없으면 캐시하지 않는다 */
export type ResponseCache = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
};
export const PLACES_CACHE_MS = 60_000;
/** 상세 보충(pending)이 남은 응답은 짧게만 둔다 — 같은 거점을 폴링하는 여러 화면이 계산 하나를 나눠 쓰게 */
export const PLACES_PENDING_CACHE_MS = 10_000;

/**
 * R12: 목록 응답을 엣지에 둘 시간(ms), 두지 않으면 null.
 * - 공식 API 실패가 섞인 응답(stale)만 두지 않는다.
 * - 격자를 아직 다 모으지 못했으면(예산·요청 제한) 10초 — 같은 거점을 폴링하는 화면들이 계산 하나를 나눠 쓴다.
 * - 다 찬 응답, 또는 상세 가져오기가 멈춘 동안(R10 쿨다운·R44 frozen — pending을 줄일 수 없다)은 60초.
 * - pending만 남았으면 10초 (그 사이 폴링은 보충을 다시 시작하지 않고 같은 응답을 받는다).
 */
export function placesCacheTtl(res: PlacesResponse | PlacesMeta): number | null {
  if (res.stale) return null;
  if (res.incompleteTiles > 0) return PLACES_PENDING_CACHE_MS;
  if (res.pending === 0 || res.detailsPaused || res.detailsFrozenSince !== null) return PLACES_CACHE_MS;
  return PLACES_PENDING_CACHE_MS;
}
/** 응답 형식이 바뀌면 올린다 (예전 형식의 캐시를 쓰지 않게) */
export const PLACES_CACHE_VERSION = "5";
const EXPIRES_HEADER = "x-mmj-expires";
/** R42: 거점마다 키 하나 (반경은 키에 넣지 않는다 — 본문은 언제나 1000m) */
export const placesCacheKey = (hub: string) =>
  `https://cache.mmj/places?hub=${encodeURIComponent(hub)}&v=${PLACES_CACHE_VERSION}`;

export type AppDeps = {
  fetcher: FetchFn;
  cache?: ResponseCache;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rateLimit?: (env: Env, key: string) => Promise<boolean>;
  /** R36: 관리자 API 전용 제한 (ADMIN_LIMITER, 분당 120회) */
  adminRateLimit?: (env: Env, key: string) => Promise<boolean>;
};

type Vars = {
  /** R38: 이 요청이 읽고 쓴 행 수를 세는 D1 */
  db: D1Database;
  /** 응답 뒤에 이어지는 작업. 끝난 뒤에 이 요청의 D1 사용량을 기록한다 */
  defer: (p: Promise<unknown>) => void;
};
type AppEnv = { Bindings: Env; Variables: Vars };
type Ctx = Context<AppEnv>;

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const now = deps.now ?? (() => Date.now());
  const rateLimit = deps.rateLimit ?? (async (env: Env, key: string) => (await env.RATE_LIMITER.limit({ key })).success);
  const adminRateLimit =
    deps.adminRateLimit ?? (async (env: Env, key: string) => (await env.ADMIN_LIMITER.limit({ key })).success);

  // R38: 요청마다 D1 사용량을 모아서, 이어지는 작업(waitUntil)까지 끝난 뒤 한 번만 기록한다.
  // 이벤트 수집은 읽기가 거의 없어서 기록하지 않는다 (쓰기 추정치는 insertEvents가 같은 배치로 더한다)
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/events") {
      c.set("db", c.env.DB);
      c.set("defer", (p) => c.executionCtx.waitUntil(p));
      return next();
    }
    const usage: D1Usage = { read: 0, written: 0 };
    const later: Promise<unknown>[] = [];
    c.set("db", meteredDb(c.env.DB, usage));
    c.set("defer", (p) => later.push(p));
    try {
      await next();
    } finally {
      c.executionCtx.waitUntil(
        Promise.allSettled(later)
          .then(() => recordD1Usage(c.env.DB, usage, now()))
          .catch((e) => console.error("d1 usage record failed", e)),
      );
    }
  });

  const serviceDeps = (c: Ctx): ServiceDeps => {
    const key = c.req.header("cf-connecting-ip") ?? "anonymous";
    return {
      db: c.var.db,
      fetcher: deps.fetcher,
      restKey: c.env.KAKAO_REST_KEY,
      ...limitsFrom(c.env),
      now: now(),
      rateLimit: () => rateLimit(c.env, key),
      waitUntil: (p) => c.var.defer(p),
      sleep: deps.sleep,
    };
  };

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/places", async (c) => {
    c.header("Cache-Control", "no-store");
    const q = PlacesQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_params" }, 400);
    const hub = HUBS.find((h) => h.id === q.data.hub)!;
    // 거점이 몇 개뿐이라 같은 요청이 반복된다. 응답을 잠깐 캐시해서 D1 읽기와 CPU를 아낀다 (placesCacheTtl).
    // R42: 어떤 반경이 와도 1000m 하나만 계산·캐시한다 (거점당 키 하나)
    const key = new Request(placesCacheKey(hub.id));
    const hit = await deps.cache?.match(key);
    if (hit && Number(hit.headers.get(EXPIRES_HEADER)) > now()) {
      return new Response(hit.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const res = await getPlaces(serviceDeps(c), { lat: hub.lat, lng: hub.lng }, MAX_RADIUS);
    if ("error" in res) return c.json(res, 502);
    const { items, ...meta } = res;
    const body = placesBody(meta, items);
    const ttl = placesCacheTtl(meta);
    if (deps.cache && ttl !== null) {
      const stored = new Response(body, {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ttl / 1000}, s-maxage=${ttl / 1000}`,
          [EXPIRES_HEADER]: String(now() + ttl),
        },
      });
      c.executionCtx.waitUntil(deps.cache.put(key, stored).catch((e) => console.error("cache put failed", e)));
    }
    return c.body(body, 200, { "content-type": "application/json" });
  });

  app.get("/api/places/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.param("id");
    if (!PLACE_ID.test(id)) return c.json({ error: "not_found" }, 404);
    const place = await getPlace(serviceDeps(c), id);
    if (!place) return c.json({ error: "not_found" }, 404);
    return c.json(place);
  });

  // R35: 익명 사용 이벤트. 화면을 막지 않게 항상 본문 없이 답한다
  app.post("/api/events", async (c) => {
    // 다른 사이트가 보낸 이벤트는 읽지도 저장하지도 않는다 (화면을 막지 않게 똑같이 204)
    if (!eventOriginAllowed(c.req.header("origin"))) return c.body(null, 204);
    if (Number(c.req.header("content-length") ?? 0) > MAX_EVENT_BODY_BYTES) return c.json({ error: "too_large" }, 400);
    const buf = await c.req.arrayBuffer();
    if (buf.byteLength > MAX_EVENT_BODY_BYTES) return c.json({ error: "too_large" }, 400);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      return c.json({ error: "invalid_body" }, 400);
    }
    const batch = parseEventBatch(json, now());
    if (!batch) return c.json({ error: "invalid_body" }, 400);
    c.header("x-mmj-dropped", String(batch.dropped));
    if (batch.events.length === 0) return c.body(null, 204);
    // 익명 id별 요청 제한(RATE_LIMITER, 분당 10회 × 최대 20개). 익명 id는 브라우저가 고르는 값이라
    // 우회할 수 있으므로, 그와 상관없이 오늘(UTC) D1 쓰기가 D1_WRITE_SOFT_CAP을 넘으면 저장하지 않는다(meta 2행 조회).
    // IP 기준 제한은 쓰지 않는다 — 사무실은 IP 하나를 함께 쓰고 RATE_LIMITER는 분당 10회라 너무 빡빡하다.
    try {
      if (!(await rateLimit(c.env, `ev:${batch.anon}`))) return c.body(null, 204);
      if (await overWriteBudget(c.var.db, c.env, now())) return c.body(null, 204);
      await insertEvents(c.var.db, batch.anon, batch.session, batch.events, now());
    } catch (e) {
      // 통계는 화면을 막지 않는다 — 실패는 기록만 하고 204
      console.error("event ingest failed", e);
    }
    return c.body(null, 204);
  });

  // R36: 모든 관리자 요청을 토큰 비교 전에 IP별 전용 제한 ADMIN_LIMITER(분당 120회)로 센다. 넘으면 맞는 토큰이어도 429 rate_limited.
  // warm.mjs(초당 ~1회)가 걸리지 않게 화면용 RATE_LIMITER(분당 10회)와 따로 둔다. warm.mjs는 rate_limited면 30초 기다렸다 다시 한다.
  // IP는 제한 키로만 쓰고(메모리) 어디에도 저장하지 않는다
  app.use("/api/admin/*", async (c, next) => {
    const ip = c.req.header("cf-connecting-ip") ?? "anonymous";
    if (!(await adminRateLimit(c.env, `admin:${ip}`))) return c.json({ error: "rate_limited" }, 429);
    const token = c.env.ADMIN_TOKEN;
    if (token && c.req.header("authorization") === `Bearer ${token}`) return next();
    return c.json({ error: "unauthorized" }, 401);
  });

  app.post("/api/admin/warm", async (c) => {
    const q = AreaQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_params" }, 400);
    // R38: 오늘 D1 읽기가 소프트 한도를 넘었으면 더 수집하지 않는다 (scripts/warm.mjs는 429에서 멈춘다)
    if (await overReadBudget(c.var.db, c.env, now())) return c.json({ error: "read_budget" }, 429);
    const r = await warmOnce(
      { db: c.var.db, fetcher: deps.fetcher, restKey: c.env.KAKAO_REST_KEY, ...limitsFrom(c.env), now: now(), sleep: deps.sleep },
      { lat: q.data.lat, lng: q.data.lng },
      q.data.radius,
      { count: c.req.query("count") === "1" },
    );
    return c.json(r);
  });

  app.get("/api/admin/stats", async (c) => {
    c.header("Cache-Control", "no-store");
    const q = StatsQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_params" }, 400);
    return c.json(await eventStats(c.var.db, { ...q.data, now: now(), readSoftCap: readSoftCap(c.env) }));
  });

  app.get("/api/admin/audit", async (c) => {
    const q = AreaQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_params" }, 400);
    return c.json(await auditArea(c.var.db, { lat: q.data.lat, lng: q.data.lng }, q.data.radius));
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  // 처리하지 못한 오류: 원인(스택·메시지)은 Workers 로그에만 남기고 화면에는 JSON 한 줄만 준다
  app.onError((e, c) => {
    console.error("unhandled", c.req.method, c.req.path, e);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
