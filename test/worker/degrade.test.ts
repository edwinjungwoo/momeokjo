import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DETAIL_FREEZE_MS, DETAIL_OK_TTL_MS, DETAIL_JITTER_MS, PLACE_BLOCK_COOLDOWN_MS, PREWARM_RADIUS } from "../../shared/constants";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { HUBS, hubById } from "../../shared/hubs";
import type { PlacesResponse } from "../../shared/types";
import { createApp, placesCacheKey } from "../../worker/app";
import { runScheduled } from "../../worker/maintenance";
import { detailGate, frozenSince, markTile, recordPlaceBlock, replaceTilePlaces } from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { doc, fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { markOuterTilesFresh, placeJson, seedPlace } from "../helpers/places";

const NOW = 1_800_000_000_000; // 2027-01-15 17:00 KST
const H = 3600_000;
const HUB = hubById("bongeunsa");
const at = (dLat: number) => HUB.lat + dLat;
const Q = "/api/places?hub=bongeunsa&radius=300";

// 서버는 반경과 상관없이 1000m를 계산한다 — 300m 밖 격자는 방금 수집한 빈 격자로 둔다
beforeEach(() => markOuterTilesFresh(env.DB, HUB, 300, NOW));

/** 같은 KST 날(2027-01-15)에 쿨다운 3번 → frozen */
async function freeze(t = NOW - 2 * H) {
  for (const dt of [0, H, 2 * H]) await recordPlaceBlock(env.DB, t - 2 * H + dt);
}

function setup(opts: { cache?: Cache } = {}) {
  const local = fakeKakaoLocal([doc("1001", at(0.0005), HUB.lng), doc("1002", at(0.001), HUB.lng)]);
  const place = fakePlaceApi({
    "1001": placeJson({ name: "가게1001", lat: at(0.0005), lng: HUB.lng }),
    "1002": placeJson({ name: "가게1002", lat: at(0.001), lng: HUB.lng }),
  });
  const app = createApp({
    fetcher: routeFetch(local.fetcher, place.fetcher), now: () => NOW, sleep: async () => {}, rateLimit: async () => true,
    cache: opts.cache,
  });
  return { app, local, place, fetcher: routeFetch(local.fetcher, place.fetcher) };
}

describe("R44 상세 차단 시 강등 모드", () => {
  it("R44: 같은 KST 날에 쿨다운이 3번 걸리면 24시간 frozen, 다른 날 1번씩은 아니다", async () => {
    await recordPlaceBlock(env.DB, NOW - 30 * H); // 2027-01-14
    await recordPlaceBlock(env.DB, NOW - 26 * H); // 2027-01-14
    await recordPlaceBlock(env.DB, NOW - H); // 2027-01-15
    expect(frozenSince(await detailGate(env.DB), NOW)).toBeNull();
    await recordPlaceBlock(env.DB, NOW - 0.5 * H);
    expect(frozenSince(await detailGate(env.DB), NOW)).toBeNull();
    await recordPlaceBlock(env.DB, NOW);
    const g = await detailGate(env.DB);
    expect(frozenSince(g, NOW)).toBe(NOW);
    expect(g.frozen).toEqual({ since: NOW, until: NOW + DETAIL_FREEZE_MS });
    // 24시간 뒤 자동 해제
    expect(frozenSince(g, NOW + DETAIL_FREEZE_MS - 1)).toBe(NOW);
    expect(frozenSince(g, NOW + DETAIL_FREEZE_MS)).toBeNull();
  });

  it("R44: 쿨다운이 이미 걸려 있는 동안의 차단 보고는 횟수에 넣지 않는다 (겹친 실행이 한 사고를 여러 번 세지 않게)", async () => {
    const count = async () =>
      Number(
        (await env.DB.prepare("SELECT value FROM meta WHERE key = 'block_count:2027-01-15'").first<{ value: string }>())
          ?.value ?? 0,
      );
    await recordPlaceBlock(env.DB, NOW - 2 * H);
    await recordPlaceBlock(env.DB, NOW - 2 * H);
    expect(await count()).toBe(1);
    // 쿨다운은 여전히 마지막 보고 기준으로 걸린다
    expect((await detailGate(env.DB)).blockedUntil).toBe(NOW - 2 * H + PLACE_BLOCK_COOLDOWN_MS);
    // 쿨다운 안의 보고 3번(요청 보충·Cron·R13이 겹침)으로는 frozen이 되지 않는다
    await recordPlaceBlock(env.DB, NOW - 2 * H + 1);
    expect(await count()).toBe(1);
    expect((await detailGate(env.DB)).frozen).toBeNull();
    // 쿨다운이 끝난 뒤 다시 막히면 센다
    await recordPlaceBlock(env.DB, NOW - 2 * H + 1 + PLACE_BLOCK_COOLDOWN_MS);
    expect(await count()).toBe(2);
  });

  it("R44: frozen 중에 또 막히면 시작 시각은 두고 해제 시각만 늘린다", async () => {
    await freeze(NOW - H);
    const since = (await detailGate(env.DB)).frozen!.since;
    await recordPlaceBlock(env.DB, NOW);
    expect((await detailGate(env.DB)).frozen).toEqual({ since, until: NOW + DETAIL_FREEZE_MS });
  });

  it("R44: frozen이면 /api/places는 보충을 시작하지 않고 detailsFrozenSince를 주며, pending이 남아도 캐시한다", async () => {
    await freeze();
    const since = (await detailGate(env.DB)).frozen!.since;
    const cache = caches.default;
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
    const { app, place } = setup({ cache });
    const body = (await (await callApp(app, Q)).json()) as PlacesResponse;
    expect(place.calls).toHaveLength(0);
    expect(body.pending).toBe(2);
    expect(body.detailsFrozenSince).toBe(since);
    expect(await cache.match(new Request(placesCacheKey("bongeunsa")))).toBeDefined();
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
  });

  it("R44: 평소에는 detailsFrozenSince가 null이고 detailsNewestAt은 실린 가게 중 가장 최근 상세 시각", async () => {
    await seedPlace(env.DB, "1001", at(0.0005), HUB.lng, { now: NOW - 5 * 24 * H });
    await seedPlace(env.DB, "1002", at(0.001), HUB.lng, { now: NOW - 2 * 24 * H });
    const byTile = new Map<string, string[]>();
    for (const [id, dLat] of [["1001", 0.0005], ["1002", 0.001]] as const) {
      const k = tileKeyOf({ lat: at(dLat), lng: HUB.lng });
      byTile.set(k, [...(byTile.get(k) ?? []), id]);
    }
    for (const k of tilesCoveringCircle(HUB, 300)) await markTile(env.DB, k, NOW, 0, false);
    for (const [k, ids] of byTile) await replaceTilePlaces(env.DB, k, ids, NOW, false);
    // 1002는 그 뒤에 실패로 기록됐다 (실패 시각은 상세 시각이 아니다)
    await env.DB.prepare("UPDATE places SET status = 'failed', fetched_at = ? WHERE id = '1002'").bind(NOW - H).run();
    const { app } = setup();
    const body = (await (await callApp(app, Q)).json()) as PlacesResponse;
    expect(body.places.map((p) => p.id).sort()).toEqual(["1001", "1002"]);
    expect(body.detailsFrozenSince).toBeNull();
    expect(body.detailsNewestAt).toBe(NOW - 5 * 24 * H);
  });

  it("R44: frozen이면 R13은 외부 호출 없이 404", async () => {
    await freeze();
    const { app, place } = setup();
    await replaceTilePlaces(env.DB, tileKeyOf(HUB), ["1001"], NOW, false);
    expect((await callApp(app, "/api/places/1001")).status).toBe(404);
    expect(place.calls).toHaveLength(0);
  });

  it("R44: frozen이면 Cron은 격자는 수집하지만 상세 후보를 읽지도 부르지도 않는다", async () => {
    await freeze();
    const hubs = [HUBS[0]];
    const keys = tilesCoveringCircle(hubs[0], PREWARM_RADIUS);
    for (const k of keys) await markTile(env.DB, k, NOW, 0, false);
    await markTile(env.DB, keys[0], 0, 0, false); // 만료된 격자 하나
    await seedPlace(env.DB, "1001", at(0.0005), HUB.lng, { now: NOW - DETAIL_OK_TTL_MS - DETAIL_JITTER_MS - H });
    await replaceTilePlaces(env.DB, tileKeyOf({ lat: at(0.0005), lng: HUB.lng }), ["1001", "1002"], NOW, false);
    const sqls: string[] = [];
    const DB = new Proxy(env.DB, {
      get(t, k) {
        if (k === "prepare") return (q: string) => (sqls.push(q), t.prepare(q));
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const { local, place, fetcher } = setup();
    const r = await runScheduled({ ...env, DB }, { fetcher, now: NOW, sleep: async () => {}, hubs });
    expect(local.calls.length).toBeGreaterThan(0);
    expect(place.calls).toHaveLength(0);
    expect(r.enriched).toBe(0);
    // 만료 후보(fetched_at 범위)와 미수집 후보(격자-장소 상태 tile_places tp — 예전 전체 조회·Task 34 가까운 순 조회 모두)를 읽지 않는다
    expect(sqls.some((q) => q.includes("p.fetched_at <="))).toBe(false);
    expect(sqls.some((q) => q.includes("tile_places tp"))).toBe(false);
  });

  it("R44: 24시간이 지나면 다시 보충한다", async () => {
    await freeze(NOW - DETAIL_FREEZE_MS - 3 * H);
    const { app, place } = setup();
    await callApp(app, Q);
    expect(place.calls.length).toBeGreaterThan(0);
  });
});
