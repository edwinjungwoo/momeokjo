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

/** R12: 공개 목록 API는 거점 id와 50m 단위 반경만 받는다 (좌표는 서버가 shared/hubs.ts에서 찾는다) */
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
 * 다 찬 응답은 60초. R44 frozen이면 pending이 줄지 않으므로 남아 있어도 60초.
 * pending만 남았으면 10초 (그 사이 폴링은 보충을 다시 시작하지 않고 같은 응답을 받는다).
 * 격자를 아직 수집하는 중이거나 stale(요청 제한·외부 실패)이면 두지 않는다.
 */
export function placesCacheTtl(res: PlacesResponse): number | null {
  if (res.incompleteTiles > 0 || res.stale) return null;
  if (res.pending === 0 || res.detailsFrozenSince !== null) return PLACES_CACHE_MS;
  return PLACES_PENDING_CACHE_MS;
}
/** 응답 형식이 바뀌면 올린다 (예전 형식의 캐시를 쓰지 않게) */
export const PLACES_CACHE_VERSION = "2";
const EXPIRES_HEADER = "x-mmj-expires";
export const placesCacheKey = (hub: string, radius: number) =>
  `https://cache.mmj/places?hub=${encodeURIComponent(hub)}&radius=${radius}&v=${PLACES_CACHE_VERSION}`;

export type AppDeps = {
  fetcher: FetchFn;
  cache?: ResponseCache;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rateLimit?: (env: Env, key: string) => Promise<boolean>;
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
    // 거점이 몇 개뿐이라 같은 (거점, 반경) 요청이 반복된다. 응답을 잠깐 캐시해서 D1 읽기와 CPU를 아낀다 (placesCacheTtl).
    const key = new Request(placesCacheKey(hub.id, q.data.radius));
    const hit = await deps.cache?.match(key);
    if (hit && Number(hit.headers.get(EXPIRES_HEADER)) > now()) {
      return new Response(hit.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const res = await getPlaces(serviceDeps(c), { lat: hub.lat, lng: hub.lng }, q.data.radius);
    if ("error" in res) return c.json(res, 502);
    const body = JSON.stringify(res);
    const ttl = placesCacheTtl(res);
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

  app.use("/api/admin/*", async (c, next) => {
    const token = c.env.ADMIN_TOKEN;
    if (!token || c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
    await next();
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

  return app;
}
