import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASEM } from "../../shared/constants";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { createApp } from "../../worker/app";
import { auditArea } from "../../worker/audit";
import { runScheduled } from "../../worker/maintenance";
import { getTiles, markTile, replaceTilePlaces, saveDetailFailure } from "../../worker/repo";
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

  it("R31: warm은 격자 수집과 상세 보충을 한 번 수행하고, 반복하면 0으로 수렴한다", async () => {
    const { app } = setup();
    const warm = async () => (await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: AUTH })).json<any>();
    expect(await warm()).toEqual({ incompleteTiles: 0, pending: 0, enriched: 2, failed: 0 });
    expect(await warm()).toEqual({ incompleteTiles: 0, pending: 0, enriched: 0, failed: 0 });
  });

  it("R11: Cron은 ASEM 1500m를 예산(40회) 안에서만 수집한다", async () => {
    const { fetcher, local } = setup();
    const r = await runScheduled(env, { fetcher, now: NOW, sleep: async () => {} });
    expect(local.calls.length).toBeLessThanOrEqual(40);
    expect(r.incompleteTiles).toBeGreaterThan(0);
    expect((await getTiles(env.DB, tilesCoveringCircle(ASEM, 1500))).size).toBe(local.calls.length);
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
