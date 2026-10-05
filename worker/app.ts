import { Hono, type Context } from "hono";
import { z } from "zod";
import { MAX_RADIUS, MIN_RADIUS, isValidRadius } from "../shared/constants";
import { HUBS, isHubId } from "../shared/hubs";
import { auditArea } from "./audit";
import { limitsFrom } from "./config";
import { meteredDb, overReadBudget, recordD1Usage, type D1Usage } from "./d1Usage";
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

/** 카카오 장소 ID: 숫자만, 최대 15자리 */
export const PLACE_ID = /^\d{1,15}$/;

/** R12 응답 캐시 (Workers Cache API의 일부). 없으면 캐시하지 않는다 */
export type ResponseCache = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
};
export const PLACES_CACHE_MS = 60_000;
/** 응답 형식이 바뀌면 올린다 (예전 형식의 캐시를 쓰지 않게) */
export const PLACES_CACHE_VERSION = "1";
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

  // R38: 요청마다 D1 사용량을 모아서, 이어지는 작업(waitUntil)까지 끝난 뒤 한 번만 기록한다
  app.use("/api/*", async (c, next) => {
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
    // 거점이 몇 개뿐이라 같은 (거점, 반경) 요청이 반복된다. 다 채워진 응답은 잠깐 캐시해서 D1 읽기와 CPU를 아낀다.
    const key = new Request(placesCacheKey(hub.id, q.data.radius));
    const hit = await deps.cache?.match(key);
    if (hit && Number(hit.headers.get(EXPIRES_HEADER)) > now()) {
      return new Response(hit.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    const res = await getPlaces(serviceDeps(c), { lat: hub.lat, lng: hub.lng }, q.data.radius);
    if ("error" in res) return c.json(res, 502);
    const body = JSON.stringify(res);
    if (deps.cache && res.pending === 0 && res.incompleteTiles === 0 && !res.stale) {
      const stored = new Response(body, {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${PLACES_CACHE_MS / 1000}, s-maxage=${PLACES_CACHE_MS / 1000}`,
          [EXPIRES_HEADER]: String(now() + PLACES_CACHE_MS),
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

  app.get("/api/admin/audit", async (c) => {
    const q = AreaQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_params" }, 400);
    return c.json(await auditArea(c.var.db, { lat: q.data.lat, lng: q.data.lng }, q.data.radius));
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}
