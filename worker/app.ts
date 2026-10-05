import { Hono, type Context } from "hono";
import { z } from "zod";
import { MAX_RADIUS, MIN_RADIUS } from "../shared/constants";
import { auditArea } from "./audit";
import { limitsFrom } from "./config";
import type { FetchFn } from "./fetchFn";
import { warmOnce } from "./maintenance";
import { getPlace, getPlaces, type ServiceDeps } from "./placesService";

export const AreaQuery = z.object({
  lat: z.coerce.number().min(33).max(39),
  lng: z.coerce.number().min(124).max(132),
  radius: z.coerce.number().int().min(MIN_RADIUS).max(MAX_RADIUS),
});

export type AppDeps = {
  fetcher: FetchFn;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rateLimit?: (env: Env, key: string) => Promise<boolean>;
};

type Ctx = Context<{ Bindings: Env }>;

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Bindings: Env }>();
  const now = deps.now ?? (() => Date.now());
  const rateLimit = deps.rateLimit ?? (async (env: Env, key: string) => (await env.RATE_LIMITER.limit({ key })).success);

  const serviceDeps = (c: Ctx): ServiceDeps => {
    const key = c.req.header("cf-connecting-ip") ?? "anonymous";
    return {
      db: c.env.DB,
      fetcher: deps.fetcher,
      restKey: c.env.KAKAO_REST_KEY,
      ...limitsFrom(c.env),
      now: now(),
      rateLimit: () => rateLimit(c.env, key),
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      sleep: deps.sleep,
    };
  };

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/places", async (c) => {
    c.header("Cache-Control", "no-store");
    const q = AreaQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_params" }, 400);
    const res = await getPlaces(serviceDeps(c), { lat: q.data.lat, lng: q.data.lng }, q.data.radius);
    if ("error" in res) return c.json(res, 502);
    return c.json(res);
  });

  app.get("/api/places/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const id = c.req.param("id");
    if (!/^\d+$/.test(id)) return c.json({ error: "not_found" }, 404);
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
    const r = await warmOnce(
      { db: c.env.DB, fetcher: deps.fetcher, restKey: c.env.KAKAO_REST_KEY, ...limitsFrom(c.env), now: now(), sleep: deps.sleep },
      { lat: q.data.lat, lng: q.data.lng },
      q.data.radius,
    );
    return c.json(r);
  });

  app.get("/api/admin/audit", async (c) => {
    const q = AreaQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid_params" }, 400);
    return c.json(await auditArea(c.env.DB, { lat: q.data.lat, lng: q.data.lng }, q.data.radius));
  });

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  return app;
}
