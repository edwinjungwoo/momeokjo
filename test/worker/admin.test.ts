import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ASEM, PREWARM_RADIUS } from "../../shared/constants";
import { HUBS, type Hub } from "../../shared/hubs";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { createApp } from "../../worker/app";
import { auditArea } from "../../worker/audit";
import { MAX_DETAIL_BATCH_SIZE, limitsFrom } from "../../worker/config";
import { hubOrder, runScheduled } from "../../worker/maintenance";
import { DETAIL_OK_TTL_MS } from "../../shared/constants";
import { hubRefreshStart } from "../../worker/refreshSchedule";
import {
  NEAREST_UNFETCHED_SQL, detailJitterMs, getMeta, getTiles, markTile, recordPlaceBlock, replaceTilePlaces, saveDetailFailure,
} from "../../worker/repo";
import { recordingDb } from "../helpers/recordDb";
import { callApp } from "../helpers/callApp";
import { doc, fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { placeJson, seedPlace } from "../helpers/places";
import { UNREADY_HUB } from "../helpers/unreadyHub";

// R62: 운영 거점은 모두 공개라 테스트 전용 준비 중 거점을 HUBS에 더한다
vi.mock("../../shared/hubs", async (orig) => (await import("../helpers/unreadyHub")).withUnreadyHub(orig));

const NOW = 1_800_000_000_000;
const AUTH = { Authorization: "Bearer test-admin-token" };
/** R60: warm 응답의 D1 행 수 */
const ROWS = { rowsRead: expect.any(Number), rowsWritten: expect.any(Number) };
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
  it("R10/R63: 운영 기본값은 보수적으로 둔다 — wrangler.jsonc vars DETAIL_BATCH_SIZE 4·DETAIL_CHAR_BUDGET 200000(채우기 부스트는 2026-10-08에 끔) (설정만 바꿔 올릴 수 있다)", () => {
    expect(limitsFrom(env)).toEqual({ budgetSize: 40, batchSize: 4, detailCharBudget: 200_000, detailOnlyReadShare: 0.6 });
    // 변수가 없거나 양수가 아니면 코드 기본값 (배치는 천장 MAX_DETAIL_BATCH_SIZE)
    expect(limitsFrom({ ...env, DETAIL_BATCH_SIZE: undefined, DETAIL_CHAR_BUDGET: "0", DETAIL_ONLY_READ_SHARE: undefined } as unknown as Env)).toEqual({
      budgetSize: 40, batchSize: MAX_DETAIL_BATCH_SIZE, detailCharBudget: 600_000, detailOnlyReadShare: 0.6,
    });
  });

  it("R10/R38: DETAIL_BATCH_SIZE는 천장 MAX_DETAIL_BATCH_SIZE(8)로 자른다 — 그보다 크게 설정해도 한 실행의 D1 호출 예산을 넘지 않게 (음수·소수는 0·내림)", () => {
    expect(MAX_DETAIL_BATCH_SIZE).toBe(8);
    const withBatch = (v: string) => limitsFrom({ ...env, DETAIL_BATCH_SIZE: v } as unknown as Env).batchSize;
    expect([withBatch("50"), withBatch("8"), withBatch("4"), withBatch("2.7"), withBatch("-3"), withBatch("0")]).toEqual([8, 8, 4, 2, 0, 0]);
  });

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

  it("R36: 모든 관리자 요청은 토큰 비교 전에 ADMIN_LIMITER(admin:<IP>)를 세고, 넘으면 맞는 토큰이어도 429 rate_limited. RATE_LIMITER는 쓰지 않는다", async () => {
    const adminKeys: string[] = [];
    const sharedKeys: string[] = [];
    let allow = true;
    const app = createApp({
      fetcher: setup().fetcher, now: () => NOW, sleep: async () => {},
      rateLimit: async (_env, key) => {
        sharedKeys.push(key);
        return true;
      },
      adminRateLimit: async (_env, key) => {
        adminKeys.push(key);
        return allow;
      },
    });
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    expect((await callApp(app, "/api/admin/stats", { headers: { ...ip, Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await callApp(app, "/api/admin/stats", { headers: ip })).status).toBe(401);
    // 맞는 토큰도 센다 (warm.mjs는 429 rate_limited면 30초 기다렸다 다시 한다)
    expect((await callApp(app, "/api/admin/stats", { headers: { ...ip, ...AUTH } })).status).toBe(200);
    expect(adminKeys).toEqual(["admin:203.0.113.9", "admin:203.0.113.9", "admin:203.0.113.9"]);
    allow = false;
    for (const headers of [{ ...ip, Authorization: "Bearer nope" }, { ...ip, ...AUTH }]) {
      const over = await callApp(app, "/api/admin/stats", { headers });
      expect(over.status).toBe(429);
      expect(await over.json()).toEqual({ error: "rate_limited" });
    }
    expect((await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: { ...ip, ...AUTH } })).status).toBe(429);
    expect(sharedKeys).toEqual([]);
    // IP는 제한 키로만 쓰고 어디에도 저장하지 않는다
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM events").all()).results,
      (await env.DB.prepare("SELECT * FROM meta").all()).results,
    ]);
    expect(dump).not.toContain("203.0.113.9");
  });

  it("R36: 기본 관리자 제한은 ADMIN_LIMITER 바인딩을 쓴다", async () => {
    const keys: string[] = [];
    const app = createApp({ fetcher: setup().fetcher, now: () => NOW, sleep: async () => {} });
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    };
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("http://localhost/api/admin/stats", { headers: { ...AUTH, "cf-connecting-ip": "198.51.100.7" } }),
      { ...env, ADMIN_LIMITER: limiter },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(429);
    expect(keys).toEqual(["admin:198.51.100.7"]);
    expect(typeof env.ADMIN_LIMITER?.limit).toBe("function");
  });

  it("R31: warm은 격자 수집과 상세 보충을 한 번 수행하고, 반복하면 0으로 수렴한다", async () => {
    const { app } = setup();
    const warm = async () => (await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: AUTH })).json<any>();
    expect(await warm()).toEqual({ incompleteTiles: 0, pending: 0, enriched: 2, failed: 0, deferred: 0, chars: expect.any(Number), truncated: false, ...ROWS });
    expect(await warm()).toEqual({ incompleteTiles: 0, pending: 0, enriched: 0, failed: 0, deferred: 0, chars: expect.any(Number), truncated: false, ...ROWS });
  });

  it("R31/R10: warm은 상세 JSON 글자 예산(DETAIL_CHAR_BUDGET)을 다 쓰면 남은 곳을 남기고 pending은 more — 다음 warm이 이어 하고 끝나면 0", async () => {
    const ids = ["2001", "2002", "2003", "2004", "2005"];
    const local = fakeKakaoLocal(ids.map((id, k) => doc(id, at(0.0002 * (k + 1)), ASEM.lng)));
    const place = fakePlaceApi(Object.fromEntries(ids.map((id, k) => [id, placeJson({ name: id, lat: at(0.0002 * (k + 1)), lng: ASEM.lng })])));
    const app = createApp({ fetcher: routeFetch(local.fetcher, place.fetcher), now: () => NOW, sleep: async () => {}, rateLimit: async () => true });
    const tight = { ...env, DETAIL_CHAR_BUDGET: "1" } as unknown as Env;
    const warm = async () => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`http://localhost/api/admin/warm?${AREA}`, { method: "POST", headers: AUTH }), tight, ctx);
      await waitOnExecutionContext(ctx);
      return res.json<any>();
    };
    // 동시에 시작한 3곳만 하고 2곳은 남긴다 (실패로 기록하지 않는다)
    const B = limitsFrom(env).batchSize; // 이번에 고르는 곳 수 (운영 설정)
    expect(await warm()).toEqual({
      incompleteTiles: 0, pending: "more", enriched: 3, failed: 0, deferred: Math.min(ids.length, B) - 3, chars: expect.any(Number), truncated: false, ...ROWS,
    });
    expect(await warm()).toEqual({ incompleteTiles: 0, pending: 0, enriched: 2, failed: 0, deferred: 0, chars: expect.any(Number), truncated: false, ...ROWS });
    expect(place.calls.map((c) => c.id).sort()).toEqual(ids);
  });

  it("R11/R10: Cron도 상세 JSON 글자 예산을 지킨다 — 남은 곳은 다음 실행이 가까운 순으로 이어 한다", async () => {
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    const ids = ["3001", "3002", "3003", "3004", "3005"];
    await replaceTilePlaces(env.DB, tileKeyOf(HUBS[0]), ids, NOW, false);
    const place = fakePlaceApi(Object.fromEntries(ids.map((id) => [id, placeJson({ name: id, lat: HUBS[0].lat, lng: HUBS[0].lng })])));
    const tight = { ...env, DETAIL_CHAR_BUDGET: "1" } as unknown as Env;
    const r1 = await runScheduled(tight, { fetcher: place.fetcher, now: NOW + 1, sleep: async () => {} });
    // Cron 결과(로그 줄)에 남긴 곳과 읽은 본문 글자 수를 싣는다
    expect(r1).toMatchObject({ enriched: 3, failed: 0, calls: 3, deferred: Math.min(ids.length, limitsFrom(env).batchSize) - 3, chars: 3 * JSON.stringify(placeJson({ name: "3001", lat: HUBS[0].lat, lng: HUBS[0].lng })).length });
    expect(place.calls.map((c) => c.id)).toEqual(ids.slice(0, 3));
    const r2 = await runScheduled(tight, { fetcher: place.fetcher, now: NOW + 2, sleep: async () => {} });
    expect(r2).toMatchObject({ enriched: 2, failed: 0 });
    expect(place.calls.map((c) => c.id)).toEqual(ids);
    // 다 채웠으면 더 고를 미수집이 없다 (다음 실행은 상세 API를 부르지 않는다)
    const r3 = await runScheduled(tight, { fetcher: place.fetcher, now: NOW + 3, sleep: async () => {} });
    expect(r3).toMatchObject({ enriched: 0, failed: 0, calls: 0 });
    expect(place.calls).toHaveLength(ids.length);
  });

  it("R11: DETAIL_BATCH_SIZE가 0이면 Cron은 미수집을 읽지 않는다(커서도 쓰지 않는다). 배치가 있으면 채우고, 앞선 커서가 끝에 닿으면 그 뒤로는 미수집 묶음 조회를 하지 않는다", async () => {
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    await replaceTilePlaces(env.DB, tileKeyOf(HUBS[0]), ["4001"], NOW, false);
    const place = fakePlaceApi({ "4001": placeJson({ name: "x", lat: HUBS[0].lat, lng: HUBS[0].lng }) });
    const zero = { ...env, DETAIL_BATCH_SIZE: "0" } as unknown as Env;
    expect(await runScheduled(zero, { fetcher: place.fetcher, now: NOW + 1, sleep: async () => {} })).toMatchObject({ enriched: 0 });
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key = 'unfetched_from'").first()).toBeNull();
    await runScheduled(env, { fetcher: place.fetcher, now: NOW + 2, sleep: async () => {} });
    expect(place.calls.map((c) => c.id)).toEqual(["4001"]);
    // 커서가 끝까지 가도록 몇 번 (실행마다 많아야 6묶음)
    for (let t = 3; t <= 8; t++) await runScheduled(env, { fetcher: place.fetcher, now: NOW + t, sleep: async () => {} });
    const { db, log } = recordingDb(env.DB);
    await runScheduled({ ...env, DB: db }, { fetcher: place.fetcher, now: NOW + 9, sleep: async () => {} });
    expect(log.filter((x) => x.sql === NEAREST_UNFETCHED_SQL)).toHaveLength(0);
    expect(place.calls).toHaveLength(1);
  });

  it("R31/R38: (거점 밖 좌표) warm 후보 고르기가 쪽 상한에서 멈추면(truncated) 고른 곳이 배치보다 적어도 pending은 more", async () => {
    // R63: 거점 격자는 갱신 시작 뒤에 가져온 행을 SQL이 걸러서 쪽 상한에 걸리지 않는다 — 지터를 SQL이 볼 수 없는 거점 밖 좌표로 본다
    const OUTSIDE = { lat: ASEM.lat + 0.3, lng: ASEM.lng };
    const keys = tilesCoveringCircle(OUTSIDE, 300);
    for (const k of keys) await markTile(env.DB, k, NOW, 0, false);
    // 가장 가까운 칸에 아직 만료되지 않은(지터 창 안) 행을 쪽 상한(100 + 400 + 1600행)보다 많이 → 후보를 하나도 못 고른다
    const ids = Array.from({ length: 2200 }, (_, i) => `w${String(i).padStart(5, "0")}`);
    const rows = ids.map((id) => [id, NOW - DETAIL_OK_TTL_MS - detailJitterMs(id) + 1]);
    for (let i = 0; i < rows.length; i += 200) {
      await env.DB.prepare(
        `INSERT INTO places (id, status, fetched_at) SELECT json_extract(value, '$[0]'), 'ok', json_extract(value, '$[1]') FROM json_each(?)`,
      ).bind(JSON.stringify(rows.slice(i, i + 200))).run();
    }
    await replaceTilePlaces(env.DB, tileKeyOf(OUTSIDE), [...ids, "zzfar"], NOW, false);
    const { app, place } = setup();
    const area = `lat=${OUTSIDE.lat}&lng=${OUTSIDE.lng}&radius=300`;
    const r = await (await callApp(app, `/api/admin/warm?${area}`, { method: "POST", headers: AUTH })).json<any>();
    expect(r).toMatchObject({ enriched: 0, failed: 0, pending: "more", truncated: true });
    expect(place.calls).toHaveLength(0);
  });

  it("R60: warm 응답에 이번 호출이 읽고 쓴 D1 행 수를 싣는다 (관리 화면 진행 표시)", async () => {
    const { app } = setup();
    const r = await (await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: AUTH })).json<any>();
    expect(r.rowsRead).toBeGreaterThan(0);
    expect(r.rowsWritten).toBeGreaterThan(0);
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
    const a: Hub = { id: "a", name: "a", lat: ASEM.lat, lng: ASEM.lng, ready: true, refreshDay: 1 };
    const b: Hub = { id: "b", name: "b", lat: ASEM.lat + 0.001, lng: ASEM.lng, ready: true, refreshDay: 1 };
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

    // R63: 다음 갱신 요일(봉은사 월요일) 00:00 뒤 — 격자도 그날 다시 모은다 (여기서는 막 모은 것으로 둔다)
    const later = hubRefreshStart(hub, NOW) + 7 * 24 * 3600_000 + 3600_000;
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, later - 1, 0, false);
    await run(later);
    expect(place.calls).toHaveLength(4);
    expect((await getMeta(env.DB, "1001"))?.fetchedAt).toBe(later);
  });

  it("R12: Cron은 list_json이 없는 예전 행(0005 전)을 채운다 — 상세 가져오기가 멈춘(쿨다운) 동안에도", async () => {
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    await seedPlace(env.DB, "1001", ASEM.lat, ASEM.lng, { now: NOW });
    const want = (await env.DB.prepare("SELECT list_json FROM places WHERE id = '1001'").first<{ list_json: string }>())!.list_json;
    await env.DB.prepare("UPDATE places SET list_json = NULL").run();
    await recordPlaceBlock(env.DB, NOW);
    const r = await runScheduled(env, { fetcher: setup().fetcher, now: NOW + 1, sleep: async () => {} });
    expect(r.listJsonFilled).toBe(1);
    const got = await env.DB.prepare("SELECT list_json FROM places WHERE id = '1001'").first<{ list_json: string }>();
    expect(got?.list_json).toBe(want);
  });

  it("R11: Cron 결과에는 pending 수를 세지 않는다 (관리용 warm만 센다)", async () => {
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    const r = await runScheduled(env, { fetcher: setup().fetcher, now: NOW, sleep: async () => {} });
    expect([...r.order].sort()).toEqual(HUBS.map((h) => h.id).sort());
    expect(r).not.toHaveProperty("pending");
  });

  it("R62: 본 Cron은 준비 중 거점도 수집·보충한다 (공개 전에 데이터를 채우게)", async () => {
    const unready = HUBS.filter((h) => !h.ready);
    expect(unready).toEqual([UNREADY_HUB]);
    // 공개 거점 격자는 방금 모았다고 두고, 준비 중 거점 격자만 남긴다
    for (const h of HUBS.filter((x) => x.ready)) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    const r = await runScheduled(env, { fetcher: setup().fetcher, now: NOW, sleep: async () => {} });
    for (const h of unready) expect(r.order, h.id).toContain(h.id);
    expect(r.tiles.total).toBe(new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS))).size);
    // 준비 중 거점의 격자도 이번 실행에서 수집 대상이다
    const collected = new Set((await getTiles(env.DB, unready.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)))).keys());
    expect(collected.size).toBeGreaterThan(0);
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
