import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ASEM, DETAIL_FAIL_TTL_MS, DETAIL_JITTER_MS, DETAIL_OK_TTL_MS, TILE_TTL_MS,
} from "../../shared/constants";
import { boundingBox, tileKeyOf } from "../../shared/geo";
import {
  blockPlaceApi, countNeedingDetail, countUnfetched, detailJitterMs, getMeta, placeBlockedUntil, getTiles, idsNeedingDetail, isDetailDue, isTileDue, markTile,
  placeById, placesByIds, placesInBox, replaceTilePlaces, saveDetail, saveDetailFailure, tilePlaceStates,
} from "../../worker/repo";
import { makeSummary, sampleDetail, seedPlace } from "../helpers/places";

const NOW = 1_800_000_000_000;
const KA = tileKeyOf(ASEM);
const [I, J] = KA.split(":").map(Number);
const KB = `${I + 3}:${J}`; // 약 750m 북쪽 격자

describe("repo", () => {
  it("R4: 격자의 ID 목록을 기록하고, 다시 기록하면 통째로 바뀐다 (중복은 하나로)", async () => {
    await replaceTilePlaces(env.DB, KA, ["1", "2", "2"], NOW, false);
    expect((await tilePlaceStates(env.DB, [KA])).map((t) => t.id).sort()).toEqual(["1", "2"]);
    expect((await getTiles(env.DB, [KA])).get(KA)).toEqual({ collectedAt: NOW, saturated: false });
    await replaceTilePlaces(env.DB, KA, ["3"], NOW + 1, true);
    expect((await tilePlaceStates(env.DB, [KA])).map((t) => t.id)).toEqual(["3"]);
    expect((await getTiles(env.DB, [KA])).get(KA)).toEqual({ collectedAt: NOW + 1, saturated: true });
  });

  it("R2: 격자 기록은 places 테이블에 아무것도 쓰지 않는다 (로컬 API 응답 저장 금지)", async () => {
    await replaceTilePlaces(env.DB, KA, ["1", "2"], NOW, false);
    const r = await env.DB.prepare("SELECT count(*) AS c FROM places").first<{ c: number }>();
    expect(r?.c).toBe(0);
  });

  it("R3: 격자 상태 7일 TTL", async () => {
    await markTile(env.DB, KA, NOW, 30, false);
    const s = (await getTiles(env.DB, [KA, "9:9"])).get(KA);
    expect(isTileDue(undefined, NOW)).toBe(true);
    expect(isTileDue(s, NOW + TILE_TTL_MS - 1)).toBe(false);
    expect(isTileDue(s, NOW + TILE_TTL_MS)).toBe(true);
  });

  it("R3: 키가 많아도(150개) 한 번에 조회한다", async () => {
    const keys = Array.from({ length: 150 }, (_, i) => `k:${i}`);
    for (const k of keys.slice(0, 3)) await replaceTilePlaces(env.DB, k, [k], NOW, false);
    expect((await getTiles(env.DB, keys)).size).toBe(3);
    expect(await tilePlaceStates(env.DB, keys)).toHaveLength(3);
  });

  it("R6: 상세 저장 후 조회하면 표시 정보와 JSON 필드가 복원된다", async () => {
    const detail = sampleDetail({ bookable: true, hours: { 1: [[660, 900], [1020, 1320]], 0: "closed" } });
    const summary = { ...makeSummary(ASEM.lat, ASEM.lng, { group: "chinese", name: "반점" }), photoUrl: "https://t1.kakaocdn.net/p" };
    await saveDetail(env.DB, "1001", summary, detail, NOW);
    await replaceTilePlaces(env.DB, KA, ["1001"], NOW, false);
    const row = (await placeById(env.DB, "1001"))!;
    expect(row.place).toEqual({
      id: "1001", name: "반점", categoryName: "음식점 > 중식", group: "chinese",
      lat: ASEM.lat, lng: ASEM.lng, address: "서울 강남구 영동대로 1", phone: null,
      photoUrl: "https://t1.kakaocdn.net/p",
      url: "https://place.map.kakao.com/1001",
    });
    expect(row.detail).toEqual({ ...detail, fetchedAt: NOW });
    expect(row.meta).toEqual({ status: "ok", fetchedAt: NOW, reason: null });
    expect(await placesInBox(env.DB, boundingBox(ASEM, 100))).toHaveLength(1);
    expect(await placesByIds(env.DB, ["1001", "9999"])).toHaveLength(1);
  });

  it("R12: 목록 조회(placesInBox)는 격자에 기록된 가게만 돌려주고, 단건 조회는 격자와 무관하다", async () => {
    await seedPlace(env.DB, "intile", ASEM.lat, ASEM.lng, { now: NOW });
    await seedPlace(env.DB, "orphan", ASEM.lat, ASEM.lng, { now: NOW });
    await replaceTilePlaces(env.DB, KA, ["intile"], NOW, false);
    expect((await placesInBox(env.DB, boundingBox(ASEM, 100))).map((r) => r.place.id)).toEqual(["intile"]);
    expect((await placeById(env.DB, "orphan"))?.place.id).toBe("orphan");
  });

  it("R9: 처음부터 실패한 장소는 표시 정보가 없다", async () => {
    await saveDetailFailure(env.DB, "1", "http_500", NOW);
    expect(await placeById(env.DB, "1")).toBeNull();
    expect(await getMeta(env.DB, "1")).toEqual({ status: "failed", fetchedAt: NOW, reason: "http_500" });
    expect(await getMeta(env.DB, "2")).toBeNull();
  });

  it("R9: 갱신에 실패해도 이전 표시 정보는 남고 상태만 failed가 된다", async () => {
    await seedPlace(env.DB, "1", ASEM.lat, ASEM.lng, { now: NOW });
    await saveDetailFailure(env.DB, "1", "http_503", NOW + 5);
    const row = (await placeById(env.DB, "1"))!;
    expect(row.place.name).toBe("가게1");
    expect(row.meta).toEqual({ status: "failed", fetchedAt: NOW + 5, reason: "http_503" });
  });

  it("R9: 상세 TTL — ok는 3일 + id별 지터, failed는 6시간", () => {
    const ok = { status: "ok" as const, fetchedAt: NOW, reason: null };
    const failed = { status: "failed" as const, fetchedAt: NOW, reason: "x" };
    const okTtl = DETAIL_OK_TTL_MS + detailJitterMs("27531028");
    expect(isDetailDue(null, NOW, "27531028")).toBe(true);
    expect(isDetailDue(ok, NOW + okTtl - 1, "27531028")).toBe(false);
    expect(isDetailDue(ok, NOW + okTtl, "27531028")).toBe(true);
    expect(isDetailDue(failed, NOW + DETAIL_FAIL_TTL_MS - 1, "27531028")).toBe(false);
    expect(isDetailDue(failed, NOW + DETAIL_FAIL_TTL_MS, "27531028")).toBe(true);
  });

  it("R9: 지터는 id로 정해지는 0~24시간 값이라 같은 날 저장한 가게들의 만료가 하루에 걸쳐 흩어진다", () => {
    expect(detailJitterMs("27531028")).toBe(detailJitterMs("27531028"));
    const js = Array.from({ length: 200 }, (_, i) => detailJitterMs(String(10_000_000 + i)));
    for (const j of js) {
      expect(Number.isInteger(j)).toBe(true);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(DETAIL_JITTER_MS);
    }
    expect(new Set(js).size).toBeGreaterThan(190);
    expect(Math.min(...js)).toBeLessThan(DETAIL_JITTER_MS * 0.1);
    expect(Math.max(...js)).toBeGreaterThan(DETAIL_JITTER_MS * 0.9);
    // 24시간을 4구간으로 나누면 구간마다 적어도 30개씩은 들어간다
    for (let q = 0; q < 4; q++) {
      const n = js.filter((j) => j >= (q * DETAIL_JITTER_MS) / 4 && j < ((q + 1) * DETAIL_JITTER_MS) / 4).length;
      expect(n).toBeGreaterThanOrEqual(30);
    }
  });

  it("R10: 차단 쿨다운 시각을 meta 테이블에 기록하고 읽는다 (없으면 0)", async () => {
    expect(await placeBlockedUntil(env.DB)).toBe(0);
    await blockPlaceApi(env.DB, NOW + 5);
    expect(await placeBlockedUntil(env.DB)).toBe(NOW + 5);
    await blockPlaceApi(env.DB, NOW + 9);
    expect(await placeBlockedUntil(env.DB)).toBe(NOW + 9);
  });

  it("R10: 상세가 필요한 ID를 격자 거리순(같으면 id순)으로, TTL을 지키며, limit만큼", async () => {
    await replaceTilePlaces(env.DB, KA, ["a1", "fresh", "oldok", "recentfail"], NOW, false);
    await replaceTilePlaces(env.DB, KB, ["b1"], NOW, false);
    await seedPlace(env.DB, "fresh", ASEM.lat, ASEM.lng, { now: NOW - 1000 });
    await seedPlace(env.DB, "oldok", ASEM.lat, ASEM.lng, { now: NOW - DETAIL_OK_TTL_MS - DETAIL_JITTER_MS });
    await saveDetailFailure(env.DB, "recentfail", "http_500", NOW - 1000);

    expect(await idsNeedingDetail(env.DB, ASEM, 1000, NOW)).toEqual(["a1", "oldok", "b1"]);
    expect(await idsNeedingDetail(env.DB, ASEM, 1000, NOW, 2)).toEqual(["a1", "oldok"]);
    expect(await countNeedingDetail(env.DB, ASEM, 1000, NOW)).toBe(3);
    expect(await countUnfetched(env.DB, [KA, KB])).toBe(2);
    // 요청 시점 보충은 한 번도 가져오지 않은 ID만 (만료 갱신은 Cron 몫)
    expect(await idsNeedingDetail(env.DB, ASEM, 1000, NOW, undefined, "unfetched")).toEqual(["a1", "b1"]);
  });
});
