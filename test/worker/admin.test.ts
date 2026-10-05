import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASEM, PREWARM_RADIUS } from "../../shared/constants";
import { HUBS, type Hub } from "../../shared/hubs";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { createApp } from "../../worker/app";
import { auditArea } from "../../worker/audit";
import { hubOrder, runScheduled } from "../../worker/maintenance";
import { DETAIL_JITTER_MS, DETAIL_OK_TTL_MS } from "../../shared/constants";
import { getMeta, getTiles, markTile, replaceTilePlaces, saveDetailFailure } from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { doc, fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { placeJson, seedPlace } from "../helpers/places";

const NOW = 1_800_000_000_000;
const AUTH = { Authorization: "Bearer test-admin-token" };
const AREA = `lat=${ASEM.lat}&lng=${ASEM.lng}&radius=300`;
const at = (dLat: number) => ASEM.lat + dLat;

function setup() {
  const local = fakeKakaoLocal([doc("1001", at(0.0005), ASEM.lng), doc("1002", at(0.001), ASEM.lng)]);
  const place = fakePlaceApi({
    "1001": placeJson({ name: "a", lat: at(0.0005), lng: ASEM.lng }),
    "1002": placeJson({ name: "b", lat: at(0.001), lng: ASEM.lng }),
  });
  const fetcher = routeFetch(local.fetcher, place.fetcher);
  const app = createApp({ fetcher, now: () => NOW, sleep: async () => {}, rateLimit: async () => true });
  return { app, local, place, fetcher };
}

describe("admin", () => {
  it("R31: 토큰이 없거나 틀리면 401", async () => {
    const { app } = setup();
    expect((await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST" })).status).toBe(401);
    expect((await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await callApp(app, `/api/admin/audit?${AREA}`)).status).toBe(401);
  });

  it("R36: 토큰을 쿼리스트링으로 보내도 인증되지 않는다 (헤더만 본다)", async () => {
    const { app } = setup();
    expect((await callApp(app, "/api/admin/stats?token=test-admin-token")).status).toBe(401);
    expect((await callApp(app, `/api/admin/audit?${AREA}&token=test-admin-token`)).status).toBe(401);
    expect((await callApp(app, "/api/admin/stats", { headers: { Authorization: "test-admin-token" } })).status).toBe(401);
  });

  it("R36: ADMIN_TOKEN이 비어 있으면 빈 Bearer를 포함해 모든 관리자 요청이 401", async () => {
    const { app } = setup();
    const call = async (path: string, init?: RequestInit) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`http://localhost${path}`, init), { ...env, ADMIN_TOKEN: "" }, ctx);
      await waitOnExecutionContext(ctx);
      return res.status;
    };
    for (const auth of [undefined, "Bearer ", "Bearer", "Bearer undefined"]) {
      const headers = auth === undefined ? undefined : { Authorization: auth };
      expect(await call("/api/admin/stats", { headers }), String(auth)).toBe(401);
      expect(await call(`/api/admin/warm?${AREA}`, { method: "POST", headers }), String(auth)).toBe(401);
    }
  });

  it("R36: 인증에 실패하면 RATE_LIMITER(admin:<IP>)를 세고, 넘으면 401 대신 429. 맞는 토큰은 제한을 쓰지 않는다", async () => {
    const keys: string[] = [];
    let allow = true;
    const app = createApp({
      fetcher: setup().fetcher, now: () => NOW, sleep: async () => {},
      rateLimit: async (_env, key) => {
        keys.push(key);
        return allow;
      },
    });
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    expect((await callApp(app, "/api/admin/stats", { headers: { ...ip, Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await callApp(app, "/api/admin/stats", { headers: ip })).status).toBe(401);
    expect(keys).toEqual(["admin:203.0.113.9", "admin:203.0.113.9"]);
    // 맞는 토큰(warm.mjs는 초당 1번 가까이 부른다)은 분당 10회 제한에 걸리지 않게 세지 않는다
    expect((await callApp(app, "/api/admin/stats", { headers: { ...ip, ...AUTH } })).status).toBe(200);
    expect(keys).toHaveLength(2);
    allow = false;
    const over = await callApp(app, "/api/admin/stats", { headers: { ...ip, Authorization: "Bearer nope" } });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect((await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: ip })).status).toBe(429);
    // IP는 제한 키로만 쓰고 어디에도 저장하지 않는다
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM events").all()).results,
      (await env.DB.prepare("SELECT * FROM meta").all()).results,
    ]);
    expect(dump).not.toContain("203.0.113.9");
  });

  it("R31: warm은 격자 수집과 상세 보충을 한 번 수행하고, 반복하면 0으로 수렴한다", async () => {
    const { app } = setup();
    const warm = async () => (await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: AUTH })).json<any>();
    expect(await warm()).toEqual({ incompleteTiles: 0, pending: 0, enriched: 2, failed: 0 });
    expect(await warm()).toEqual({ incompleteTiles: 0, pending: 0, enriched: 0, failed: 0 });
  });

  it("R11: 실행(5분)마다 시작 거점을 돌려서 모든 거점이 차례로 먼저 예산을 쓴다", () => {
    const FIVE_MIN = 5 * 60_000;
    const ids = HUBS.map((h) => h.id);
    const rotated = (k: number) => [...ids.slice(k % ids.length), ...ids.slice(0, k % ids.length)];
    expect(hubOrder(HUBS, 0).map((h) => h.id)).toEqual(rotated(0));
    expect(hubOrder(HUBS, FIVE_MIN).map((h) => h.id)).toEqual(rotated(1));
    expect(hubOrder(HUBS, 2 * FIVE_MIN + 59_000).map((h) => h.id)).toEqual(rotated(2));
    expect(hubOrder(HUBS, ids.length * FIVE_MIN).map((h) => h.id)).toEqual(rotated(0));
  });

  it("R11: Cron은 모든 거점을 1000m로, 거점끼리 나눠 쓰는 한 예산(40회) 안에서 시작 거점부터 수집한다", async () => {
    const collected = async (h: Hub) => (await getTiles(env.DB, tilesCoveringCircle(h, PREWARM_RADIUS))).size;
    const FIVE_MIN = 5 * 60_000;
    const t0 = Math.floor(NOW / FIVE_MIN) * FIVE_MIN;
    const [first, second, third] = hubOrder(HUBS, t0);

    const a = setup();
    const r1 = await runScheduled(env, { fetcher: a.fetcher, now: t0, sleep: async () => {} });
    expect(a.local.calls.length).toBeLessThanOrEqual(40);
    expect(r1.order[0]).toBe(first.id);
    expect(r1.tiles.incomplete).toBeGreaterThan(0);
    expect(await collected(first)).toBe(a.local.calls.length);
    expect(await collected(second)).toBe(0);
    expect(await collected(third)).toBe(0);

    const b = setup();
    const r2 = await runScheduled(env, { fetcher: b.fetcher, now: t0 + FIVE_MIN, sleep: async () => {} });
    expect(b.local.calls.length).toBeLessThanOrEqual(40);
    expect(r2.order[0]).toBe(second.id);
    expect(await collected(second)).toBeGreaterThan(0);
  });

  it("R11: 겹치는 거점이 있어도 한 실행에서 격자와 장소는 한 번씩만 확인·호출한다", async () => {
    const a: Hub = { id: "a", name: "a", lat: ASEM.lat, lng: ASEM.lng };
    const b: Hub = { id: "b", name: "b", lat: ASEM.lat + 0.001, lng: ASEM.lng };
    const hubs = [a, b];
    const s1 = setup();
    await runScheduled(env, { fetcher: s1.fetcher, now: NOW, sleep: async () => {}, hubs });
    const rects = s1.local.calls.map((u) => `${u.searchParams.get("rect")}#${u.searchParams.get("page") ?? "1"}`);
    expect(new Set(rects).size).toBe(rects.length);

    // 두 거점이 함께 덮는 격자의 장소는 상세도 한 번만 가져온다
    for (const h of hubs) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    await env.DB.prepare("DELETE FROM places").run();
    await replaceTilePlaces(env.DB, tileKeyOf(a), ["1001", "1002"], NOW, false);
    const s2 = setup();
    const r = await runScheduled(env, { fetcher: s2.fetcher, now: NOW + 1, sleep: async () => {}, hubs });
    expect(s2.local.calls).toHaveLength(0);
    expect(s2.place.calls.map((c) => c.id).sort()).toEqual(["1001", "1002"]);
    expect(r.enriched).toBe(2);
  });

  it("R11: Cron은 미수집 ID를 보충하고, 다 채운 뒤에는 상세 API를 부르지 않으며, 만료된 상세는 갱신한다", async () => {
    const hub = HUBS[0];
    // 모든 거점 격자를 신선하게 표시해서 격자 수집이 예산을 쓰지 않게 한다
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    await replaceTilePlaces(env.DB, tileKeyOf(hub), ["1001", "1002"], NOW, false);
    const { fetcher, place } = setup();
    const run = (now: number) => runScheduled(env, { fetcher, now, sleep: async () => {} });

    const r1 = await run(NOW + 1);
    expect(r1).toMatchObject({ enriched: 2, failed: 0 });
    expect(place.calls.map((c) => c.id).sort()).toEqual(["1001", "1002"]);

    await run(NOW + 2);
    expect(place.calls).toHaveLength(2);

    const later = NOW + 1 + DETAIL_OK_TTL_MS + DETAIL_JITTER_MS;
    await run(later);
    expect(place.calls).toHaveLength(4);
    expect((await getMeta(env.DB, "1001"))?.fetchedAt).toBe(later);
  });

  it("R11: Cron 결과에는 pending 수를 세지 않는다 (관리용 warm만 센다)", async () => {
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    const r = await runScheduled(env, { fetcher: setup().fetcher, now: NOW, sleep: async () => {} });
    expect([...r.order].sort()).toEqual(HUBS.map((h) => h.id).sort());
    expect(r).not.toHaveProperty("pending");
  });

  it("R32/Q1~Q4: 감사 리포트는 덮는 격자에 기록된 ID 집합을 기준으로 한다", async () => {
    const keys = tilesCoveringCircle(ASEM, 300);
    for (const k of keys) await markTile(env.DB, k, NOW, 0, k === keys[0]);
    await replaceTilePlaces(env.DB, tileKeyOf(ASEM), ["a", "a2", "b", "c", "e"], NOW, false);
    await seedPlace(env.DB, "a", at(0.0005), ASEM.lng, { group: "korean", name: "가게a", now: NOW });
    await seedPlace(env.DB, "a2", at(0.0005), ASEM.lng, { group: "korean", name: "가게a", now: NOW });
    await seedPlace(env.DB, "b", at(0.0006), ASEM.lng, { group: "etc", now: NOW, detail: { rating: null, hours: null } });
    await saveDetailFailure(env.DB, "c", "http_500", NOW);

    const r = await auditArea(env.DB, ASEM, 300);
    expect(r.places).toBe(5);
    expect(r.byGroup).toEqual({ korean: 2, etc: 1 });
    expect(r.etcSecondLevels).toEqual({ 뷔페: 1 });
    expect(r.tiles).toEqual({ total: keys.length, collected: keys.length, saturated: 1 });
    expect(r.detail).toEqual({ ok: 3, failed: 1, missing: 1, coverage: 0.6 });
    expect(r.nullRates).toEqual({ rating: 0.3333, price: 0, hours: 0.3333 });
    expect(r.failures).toEqual([{ id: "c", name: null, reason: "http_500" }]);
    expect(r.invalidCoords).toBe(0);
    expect(r.duplicateGroups).toBe(1);
    expect(r.pass).toEqual({ q1: false, q2: false });

    const viaApi = await (await callApp(setup().app, `/api/admin/audit?${AREA}`, { headers: AUTH })).json<any>();
    expect(viaApi.detail.coverage).toBe(0.6);
  });
});
