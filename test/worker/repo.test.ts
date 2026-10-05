import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ASEM, DETAIL_FAIL_TTL_MS, DETAIL_JITTER_MS, DETAIL_OK_TTL_MS, PLACE_BLOCK_COOLDOWN_MS, TILE_TTL_MS,
} from "../../shared/constants";
import { boundingBox, tileKeyOf } from "../../shared/geo";
import {
  countNeedingDetail, countUnfetched, detailGate, detailJitterMs, expiredDetailStates, getMeta, recordPlaceBlock,
  tilesChangedAt, unfetchedStates, getTiles, idsNeedingDetail, isDetailDue, isTileDue, markTile,
  placeById, placesByIds, placesInBox, replaceTilePlaces, saveDetail, saveDetailFailure, tilePlaceStates,
} from "../../worker/repo";
import { makeSummary, sampleDetail, seedPlace } from "../helpers/places";
import { recordingDb } from "../helpers/recordDb";

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

  it("R4: 바뀌지 않은 격자를 다시 기록하면 tile_places에 쓰지 않고 격자 상태(수집 시각)만 갱신한다", async () => {
    await replaceTilePlaces(env.DB, KA, ["1", "2", "3"], NOW, false);
    const changedAt = await tilesChangedAt(env.DB);
    const { db, log } = recordingDb(env.DB);
    await replaceTilePlaces(db, KA, ["3", "2", "1", "1"], NOW + 1, false);
    expect(log.filter((x) => /(INSERT|DELETE)[^;]*tile_places/i.test(x.sql))).toEqual([]);
    expect(log.filter((x) => /tile_places/.test(x.sql)).reduce((n, x) => n + x.written, 0)).toBe(0);
    expect((await getTiles(env.DB, [KA])).get(KA)).toEqual({ collectedAt: NOW + 1, saturated: false });
    // ID가 바뀌지 않았으니 미수집 확인(Cron)을 다시 깨우지 않는다
    expect(await tilesChangedAt(env.DB)).toBe(changedAt);
  });

  it("R4: 하나 추가·하나 제거면 tile_places 문장은 2개(제거 DELETE 1 + 추가 INSERT OR IGNORE 1)", async () => {
    await replaceTilePlaces(env.DB, KA, ["1", "2", "3"], NOW, false);
    const { db, log } = recordingDb(env.DB);
    await replaceTilePlaces(db, KA, ["1", "2", "4"], NOW + 1, false);
    const writes = log.filter((x) => /(INSERT|DELETE)[^;]*tile_places/i.test(x.sql));
    expect(writes).toHaveLength(2);
    expect(writes.map((x) => x.sql.trim().split(/\s+/)[0]).sort()).toEqual(["DELETE", "INSERT"]);
    expect((await tilePlaceStates(env.DB, [KA])).map((t) => t.id).sort()).toEqual(["1", "2", "4"]);
    expect(await tilesChangedAt(env.DB)).toBe(NOW + 1);
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

  it("R11: 만료 후보는 fetched_at 인덱스로 고르고(지터 전 기준), 미수집 ID는 따로 고른다 — 둘 다 주어진 격자만", async () => {
    await replaceTilePlaces(env.DB, KA, ["new", "fresh", "old", "oldfail"], NOW, false);
    await replaceTilePlaces(env.DB, KB, ["otherold", "othernew"], NOW, false);
    await seedPlace(env.DB, "fresh", ASEM.lat, ASEM.lng, { now: NOW - 1000 });
    await seedPlace(env.DB, "old", ASEM.lat, ASEM.lng, { now: NOW - DETAIL_OK_TTL_MS });
    await saveDetailFailure(env.DB, "oldfail", "http_500", NOW - DETAIL_FAIL_TTL_MS);
    await seedPlace(env.DB, "otherold", ASEM.lat, ASEM.lng, { now: NOW - DETAIL_OK_TTL_MS });
    const expired = await expiredDetailStates(env.DB, [KA], NOW);
    expect(expired.map((t) => t.id).sort()).toEqual(["old", "oldfail"]);
    expect(expired.find((t) => t.id === "old")).toEqual({
      id: "old", tileKey: KA, meta: { status: "ok", fetchedAt: NOW - DETAIL_OK_TTL_MS, reason: null },
    });
    expect((await unfetchedStates(env.DB, [KA])).map((t) => [t.id, t.meta])).toEqual([["new", null]]);
  });

  it("R11: 격자 ID를 기록하면 tiles_changed_at이 그 시각으로 바뀐다 (Cron 미수집 확인 신호)", async () => {
    expect(await tilesChangedAt(env.DB)).toBe(0);
    await replaceTilePlaces(env.DB, KA, ["1"], NOW, false);
    expect(await tilesChangedAt(env.DB)).toBe(NOW);
  });

  it("R11: 0003 마이그레이션은 places(status, fetched_at) 인덱스를 만든다", async () => {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_places_status_fetched_at'").all();
    expect(r.results).toHaveLength(1);
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

  it("R10: 차단을 기록하면 meta에 지금 + 30분 쿨다운이 남고, 다시 막히면 그때부터 30분으로 늘어난다 (없으면 0)", async () => {
    expect((await detailGate(env.DB)).blockedUntil).toBe(0);
    await recordPlaceBlock(env.DB, NOW);
    expect((await detailGate(env.DB)).blockedUntil).toBe(NOW + PLACE_BLOCK_COOLDOWN_MS);
    await recordPlaceBlock(env.DB, NOW + 9);
    expect((await detailGate(env.DB)).blockedUntil).toBe(NOW + 9 + PLACE_BLOCK_COOLDOWN_MS);
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

describe("QA D-8: 깨진 JSON 열 경고", () => {
  it("R12/D-8: 같은 행·열의 경고는 isolate마다 한 번만 남기고, 기억은 200개까지만 둔다", async () => {
    const { CORRUPT_WARN_CAP, warnCorruptOnce } = await import("../../worker/repo");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(CORRUPT_WARN_CAP).toBe(200);
      warnCorruptOnce("dedupe-1", "menus_json");
      warnCorruptOnce("dedupe-1", "menus_json");
      warnCorruptOnce("dedupe-1", "tags_json");
      expect(warn.mock.calls).toEqual([
        ["corrupt json column", { id: "dedupe-1", col: "menus_json" }],
        ["corrupt json column", { id: "dedupe-1", col: "tags_json" }],
      ]);
      // 서로 다른 키가 200개를 넘으면 기억을 비우고 다시 센다 (메모리가 끝없이 늘지 않게)
      warnCorruptOnce("cap-0", "menus_json");
      for (let i = 1; i <= 2 * CORRUPT_WARN_CAP; i++) warnCorruptOnce(`cap-${i}`, "menus_json");
      warn.mockClear();
      warnCorruptOnce("cap-0", "menus_json");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
