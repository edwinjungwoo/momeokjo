import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  ASEM, DETAIL_FAIL_TTL_MS, DETAIL_JITTER_MS, DETAIL_OK_TTL_MS, PLACE_BLOCK_COOLDOWN_MS, TILE_TTL_MS,
} from "../../shared/constants";
import { boundingBox, haversine, tileKeyOf, tileRect, tilesCoveringCircle } from "../../shared/geo";
import { HUBS } from "../../shared/hubs";
import type { LatLng } from "../../shared/types";
import {
  countNeedingDetail, countUnfetched, detailGate, detailJitterMs, expiredDetailStates, getMeta, recordPlaceBlock,
  tilesChangedAt, unfetchedStates, getTiles, idsNeedingDetail, isDetailDue, isTileDue, markTile,
  placeById, placesByIds, placesInBox, replaceTilePlaces, saveDetail, saveDetailFailure, tilePlaceStates,
  EXPIRED_RESET_PAGES, EXPIRED_SCAN_LIMIT, EXPIRED_SCAN_SQL, LIST_BACKFILL_LIMIT, backfillListJson,
  DETAIL_PICK_FIRST_PAGE, DETAIL_PICK_GROWTH, DETAIL_PICK_MAX_PAGES, NEAREST_DUE_SQL, NEAREST_UNFETCHED_SQL,
  UNFETCHED_CHUNK_TILES, UNFETCHED_FROM_KEY, UNFETCHED_MAX_CHUNKS, dueTileKeys, nearestDetailIds, nearestUnfetchedStates,
  pickDetailIds, saveDetails, type DetailSave,
} from "../../worker/repo";
import { parseDetail } from "../../worker/detailParser";
import { readList, placesPayload } from "../../worker/placesService";
import { LIST_JSON_PREFIX, placesBody, storedListJson } from "../../worker/present";
import { MARK_PLACES_DIRTY_SQL, SNAPSHOT_DIRTY_PREFIX } from "../../worker/snapshotDirty";
import { makeSummary, placeJson, sampleDetail, seedPlace } from "../helpers/places";
import { recordingDb } from "../helpers/recordDb";
import { tileRefreshStart } from "../../worker/refreshSchedule";

const NOW = 1_800_000_000_000;
const KA = tileKeyOf(ASEM);
const [I, J] = KA.split(":").map(Number);
const KB = `${I + 3}:${J}`; // 약 750m 북쪽 격자
/** R63: KA(봉은사 격자)의 이번 갱신 시작 — 이 전에 가져온 ok가 갱신 대상 */
const START = tileRefreshStart(KA, NOW) as number;

/** [id, fetched_at] 여러 개를 상세 ok로 한 문장에 넣는다 (좌표는 ASEM) */
async function seedMany(rows: [string, number][]) {
  await env.DB.prepare(
    `INSERT INTO places (id, status, name, category_name, category_group, lat, lng, fetched_at)
     SELECT json_extract(value, '$[0]'), 'ok', '가게', '음식점 > 한식', 'korean', ?, ?, json_extract(value, '$[1]') FROM json_each(?)`,
  ).bind(ASEM.lat, ASEM.lng, JSON.stringify(rows)).run();
}

const listJsonOf = async (id: string) =>
  (await env.DB.prepare("SELECT list_json FROM places WHERE id = ?").bind(id).first<{ list_json: string | null }>())?.list_json ?? null;

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

  it("R3: 거점 밖 격자 상태는 7일 TTL (거점 격자는 R63 갱신 요일 — weeklyRefresh.test.ts)", async () => {
    const OUT = "9:9";
    await markTile(env.DB, OUT, NOW, 30, false);
    const s = (await getTiles(env.DB, [KA, OUT])).get(OUT);
    expect(isTileDue(OUT, undefined, NOW)).toBe(true);
    expect(isTileDue(OUT, s, NOW + TILE_TTL_MS - 1)).toBe(false);
    expect(isTileDue(OUT, s, NOW + TILE_TTL_MS)).toBe(true);
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

  it("R11/R63/R66: 만료 후보는 상태 인덱스로 고르고(거점 격자 ok는 due_after가 갱신 시작 전), 미수집 ID는 따로 고른다 — 둘 다 주어진 격자만", async () => {
    expect(START).toBeGreaterThan(NOW - 7 * 24 * 3600_000);
    await replaceTilePlaces(env.DB, KA, ["new", "fresh", "afterstart", "old", "oldfail"], NOW, false);
    await replaceTilePlaces(env.DB, KB, ["otherold", "othernew"], NOW, false);
    await seedPlace(env.DB, "fresh", ASEM.lat, ASEM.lng, { now: NOW - 1000 });
    await seedPlace(env.DB, "afterstart", ASEM.lat, ASEM.lng, { now: START });
    await seedPlace(env.DB, "old", ASEM.lat, ASEM.lng, { now: START - 1 });
    await saveDetailFailure(env.DB, "oldfail", "http_500", NOW - DETAIL_FAIL_TTL_MS);
    await seedPlace(env.DB, "otherold", ASEM.lat, ASEM.lng, { now: START - 1 });
    const expired = await expiredDetailStates(env.DB, [KA], NOW);
    expect(expired.map((t) => t.id).sort()).toEqual(["old", "oldfail"]);
    // R66: 후보에는 due_after와 지난 지문이 같이 실린다 (같음·바뀜 계수)
    expect(expired.find((t) => t.id === "old")).toEqual({
      id: "old", tileKey: KA, meta: { status: "ok", fetchedAt: START - 1, reason: null, dueAfter: START - 1, fp: expect.stringMatching(/^[0-9a-f]{8}$/) },
    });
    expect((await unfetchedStates(env.DB, [KA])).map((t) => [t.id, t.meta])).toEqual([["new", null]]);
  });

  it("R11/R38: 만료 후보는 상태별로 fetched_at이 오래된 순 300개까지만 고른다", async () => {
    const ids = Array.from({ length: 310 }, (_, i) => `k${i}`);
    await seedMany(ids.map((id, i) => [id, START - 1 - (310 - i)]));
    await replaceTilePlaces(env.DB, KA, ids, NOW, false);
    await saveDetailFailure(env.DB, "f1", "http_500", NOW - DETAIL_FAIL_TTL_MS);
    await replaceTilePlaces(env.DB, KB, ["f1"], NOW, false);
    const expired = await expiredDetailStates(env.DB, [KA, KB], NOW);
    const ok = expired.filter((t) => t.meta?.status === "ok").map((t) => t.id);
    expect(ok).toHaveLength(EXPIRED_SCAN_LIMIT);
    expect(EXPIRED_SCAN_LIMIT).toBe(300);
    expect(ok).toEqual(ids.slice(0, 300));
    expect(expired.filter((t) => t.meta?.status === "failed").map((t) => t.id)).toEqual(["f1"]);
  });

  it("R11/R38: 만료 후보 조회는 (status, fetched_at) 인덱스를 범위로 읽고 places 전체 스캔·정렬용 임시 B-트리를 쓰지 않는다", async () => {
    const r = await env.DB.prepare(`EXPLAIN QUERY PLAN ${EXPIRED_SCAN_SQL}`).bind("ok", 0, 0, NOW, 300).all<{ detail: string }>();
    const plan = r.results.map((x) => x.detail).join("\n");
    expect(plan).toMatch(/SEARCH p USING INDEX idx_places_status_fetched_at \(status=\? AND fetched_at=\? AND rowid>\?\)/);
    expect(plan).toMatch(/SEARCH p USING INDEX idx_places_status_fetched_at \(status=\? AND fetched_at>\? AND fetched_at<\?\)/);
    expect(plan).not.toMatch(/SCAN p\b/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it("R11: 만료 후보 조회는 같은 시각 행에도 before(상한)를 적용한다 — 커서 시각이 상한보다 늦으면 아무것도 읽지 않는다", async () => {
    await seedPlace(env.DB, "late", ASEM.lat, ASEM.lng, { now: NOW + 100 });
    const rows = async (from: number, before: number) =>
      (await env.DB.prepare(EXPIRED_SCAN_SQL).bind("ok", from, 0, before, 300).all<{ id: string }>()).results.map((x) => x.id);
    expect(await rows(NOW + 100, NOW + 100)).toEqual(["late"]);
    expect(await rows(NOW + 100, NOW)).toEqual([]);
  });

  /** 만료 후보를 한 번 고르고 읽은 행 수를 같이 돌려준다 */
  const scan = async (keys: string[], now = NOW) => {
    const { db, log } = recordingDb(env.DB);
    const ids = (await expiredDetailStates(db, keys, now)).map((t) => t.id);
    return { ids, read: log.reduce((n, x) => n + x.read, 0), cursorWrites: log.filter((x) => /INSERT INTO meta/.test(x.sql)).length };
  };
  /** 후보 한 행을 읽는 비용: 인덱스 항목 + 표 행 + 격자 붙이기 */
  const READS_PER_ROW = 3;
  /** 거점 밖(KB) 오래된 만료 행 n개 + 거점(KA) 행 h1, h2 */
  async function seedOutsideAndHub(n: number) {
    const outside = Array.from({ length: n }, (_, i) => `o${i}`);
    await seedMany(outside.map((id, i) => [id, NOW - 10 * DETAIL_OK_TTL_MS + i]));
    await replaceTilePlaces(env.DB, KB, outside, NOW, false);
    await seedMany([["h1", START - 3], ["h2", START - 2]]);
    await replaceTilePlaces(env.DB, KA, ["h1", "h2"], NOW, false);
  }

  it("R11/R38: 거점 격자 밖 만료 행(갱신되지 않음)은 한 번 지나가면 다음 실행부터 읽지 않는다 — 격자 ID가 바뀌면 처음부터 다시", async () => {
    await seedOutsideAndHub(400);
    // 커서가 없거나 재설정되면 같은 실행에서 거점 행이 나올 때까지(최대 3 × 300행) 더 읽는다
    expect(EXPIRED_RESET_PAGES).toBe(3);
    expect((await scan([KA])).ids).toEqual(["h1", "h2"]);
    // 그다음부터는 첫 거점 행부터 읽는다
    const steady = await scan([KA]);
    expect(steady.ids).toEqual(["h1", "h2"]);
    expect(steady.read).toBeLessThan(30);
    // 격자 ID가 바뀌면(거점 격자에 오래된 행이 새로 들어왔을 수 있다) 처음부터 다시 훑는다
    await replaceTilePlaces(env.DB, KA, ["h1", "h2", "o0"], NOW + 1, false);
    expect((await scan([KA])).ids).toEqual(["o0"]);
  });

  it("R11/R38: 재설정 뒤에도 한 실행은 상태마다 3 × 300행까지만 읽고, 다음 실행이 그 자리부터 잇는다", async () => {
    await seedOutsideAndHub(1000);
    const first = await scan([KA]);
    expect(first.ids).toEqual([]);
    expect(first.read).toBeLessThanOrEqual(READS_PER_ROW * EXPIRED_RESET_PAGES * EXPIRED_SCAN_LIMIT + 10);
    expect((await scan([KA])).ids).toEqual(["h1", "h2"]);
  });

  it("R11: 격자 ID가 바뀐 시각이 커서를 쓴 시각보다 이르게 기록돼도(경합) 값이 달라졌으면 처음부터 다시 훑는다", async () => {
    await seedOutsideAndHub(400);
    await scan([KA]);
    expect((await scan([KA])).ids).toEqual(["h1", "h2"]);
    // 요청 하나가 Cron보다 먼저 시각을 잡고 늦게 격자를 기록했다 (now < 커서를 쓴 시각) — tiles_changed_at은 그래도 커진다(Task 34)
    const before = await tilesChangedAt(env.DB);
    await replaceTilePlaces(env.DB, KA, ["h1", "h2", "o5"], NOW - 60_000, false);
    expect(await tilesChangedAt(env.DB)).toBeGreaterThan(before);
    expect((await scan([KA])).ids).toEqual(["o5"]);
  });

  it("R11: 거점 격자 집합이 바뀌면(거점 추가 등) 커서를 처음부터 다시 쓴다", async () => {
    await seedOutsideAndHub(400);
    await scan([KA]);
    expect((await scan([KA])).ids).toEqual(["h1", "h2"]);
    // KB가 거점 격자가 되면 커서 앞의 오래된 KB 행도 후보다
    const both = await scan([KA, KB]);
    expect(both.ids.slice(0, 3)).toEqual(["o0", "o1", "o2"]);
    expect(both.ids).toHaveLength(EXPIRED_SCAN_LIMIT);
    // 같은 집합(순서·중복만 다름)이면 재설정하지 않는다 (커서가 그대로라 다시 쓰지 않는다)
    expect((await scan([KB, KA, KB])).cursorWrites).toBe(0);
  });

  it("R11/R38: fetched_at이 같은 행이 한 쪽(300행)보다 많아도 커서가 (fetched_at, rowid)로 넘어가 멈추지 않는다", async () => {
    const T = NOW - 10 * DETAIL_OK_TTL_MS;
    const ties = Array.from({ length: 1000 }, (_, i) => `t${i}`);
    await seedMany(ties.map((id) => [id, T]));
    await replaceTilePlaces(env.DB, KB, ties, NOW, false);
    await seedMany([["h1", T]]); // 같은 시각, 더 큰 rowid
    await replaceTilePlaces(env.DB, KA, ["h1"], NOW, false);
    expect((await scan([KA])).ids).toEqual([]); // 재설정: 3 × 300행
    const next = await scan([KA]);
    expect(next.ids).toEqual(["h1"]);
    // 남은 ~100행만 읽는다 (같은 시각의 앞 900행을 다시 읽지 않는다)
    expect(next.read).toBeLessThanOrEqual(READS_PER_ROW * 110);
    expect((await scan([KA])).ids).toEqual(["h1"]);
  });

  it("R11: 갱신한 상세의 다음 만료에도 id별 지터가 붙는다 (3일 파도가 다시 한꺼번에 오지 않게)", async () => {
    const T2 = NOW + 5 * DETAIL_OK_TTL_MS;
    for (const id of ["a", "b"]) {
      await seedPlace(env.DB, id, ASEM.lat, ASEM.lng, { now: NOW });
      await seedPlace(env.DB, id, ASEM.lat, ASEM.lng, { now: T2 }); // Cron 갱신
      const due = T2 + DETAIL_OK_TTL_MS + detailJitterMs(id);
      expect(isDetailDue(await getMeta(env.DB, id), due - 1, id)).toBe(false);
      expect(isDetailDue(await getMeta(env.DB, id), due, id)).toBe(true);
    }
    expect(detailJitterMs("a")).not.toBe(detailJitterMs("b"));
  });

  it("R12: 상세를 저장하면 목록 원소 조각(list_json, 거리 없음)도 같은 행에 같이 쓴다", async () => {
    await seedPlace(env.DB, "1001", ASEM.lat, ASEM.lng, { now: NOW });
    const r = await env.DB.prepare("SELECT list_json FROM places WHERE id = '1001'").first<{ list_json: string }>();
    expect(r?.list_json).toBe(storedListJson((await placeById(env.DB, "1001"))!));
    // 실패 기록은 조각을 건드리지 않는다 (표시 정보가 그대로 남으므로)
    await saveDetailFailure(env.DB, "1001", "http_500", NOW + 1);
    const after = await env.DB.prepare("SELECT list_json FROM places WHERE id = '1001'").first<{ list_json: string }>();
    expect(after?.list_json).toBe(r?.list_json);
  });

  it("R12/R38: list_json이 없는 예전 행은 Cron이 실행마다 200행씩 채우고, 다 채운 뒤에는 훑지 않는다", async () => {
    expect(LIST_BACKFILL_LIMIT).toBe(200);
    const ids = Array.from({ length: 250 }, (_, i) => `p${i}`);
    for (const id of ids) await seedPlace(env.DB, id, ASEM.lat, ASEM.lng, { now: NOW });
    await saveDetailFailure(env.DB, "nodetail", "http_500", NOW); // 표시 정보 없는 행은 건너뛴다
    const want = new Map<string, string>();
    for (const x of (await env.DB.prepare("SELECT id, list_json FROM places WHERE list_json IS NOT NULL").all<{ id: string; list_json: string }>()).results) {
      want.set(x.id, x.list_json);
    }
    await env.DB.prepare("UPDATE places SET list_json = NULL").run();
    const nulls = async () =>
      (await env.DB.prepare("SELECT count(*) AS c FROM places WHERE list_json IS NULL AND name IS NOT NULL").first<{ c: number }>())!.c;
    expect(await backfillListJson(env.DB)).toBe(200);
    expect(await nulls()).toBe(50);
    expect(await backfillListJson(env.DB)).toBe(50);
    expect(await nulls()).toBe(0);
    const got = (await env.DB.prepare("SELECT id, list_json FROM places WHERE name IS NOT NULL").all<{ id: string; list_json: string }>()).results;
    for (const x of got) expect(x.list_json, x.id).toBe(want.get(x.id));
    // 끝났으면 places를 다시 훑지 않는다 (meta 1행만)
    const { db, log } = recordingDb(env.DB);
    expect(await backfillListJson(db)).toBe(0);
    expect(log.reduce((n, x) => n + x.read, 0)).toBeLessThanOrEqual(2);
  });

  it("R12: Cron 백필은 판이 다르거나 깨진 조각도 다시 쓰고(NULL만이 아니다) 지금 판 조각은 두며, 판마다 처음부터 훑는다", async () => {
    const ids = ["old", "v0", "v2", "empty", "corrupt", "keep", "null"];
    for (const id of ids) await seedPlace(env.DB, id, ASEM.lat, ASEM.lng, { now: NOW });
    const want = new Map(
      (await env.DB.prepare("SELECT id, list_json FROM places").all<{ id: string; list_json: string }>()).results.map((x) => [x.id, x.list_json]),
    );
    const item = want.get("old")!.slice(LIST_JSON_PREFIX.length);
    const set = (id: string, v: string | null) => env.DB.prepare("UPDATE places SET list_json = ? WHERE id = ?").bind(v, id).run();
    await set("old", item); // 0005 직후 판 없는 조각
    await set("v0", `v0:${item}`);
    await set("v2", `v2:${item}`);
    await set("empty", "");
    await set("corrupt", "v1:garbage");
    await set("keep", `${LIST_JSON_PREFIX}{"keep":1}`);
    await set("null", null);
    // 예전 판의 커서가 끝났어도(이전 판 "done") 이번 판은 처음부터 훑는다
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('list_json_backfill', 'done')").run();
    expect(await backfillListJson(env.DB)).toBe(6);
    for (const id of ids.filter((x) => x !== "keep")) expect(await listJsonOf(id), id).toBe(want.get(id));
    expect(await listJsonOf("keep")).toBe(`${LIST_JSON_PREFIX}{"keep":1}`);
    expect(await backfillListJson(env.DB)).toBe(0);
  });

  it("R11: 격자 ID를 기록하면 tiles_changed_at이 그 시각으로 바뀐다 (Cron 미수집 확인 신호)", async () => {
    expect(await tilesChangedAt(env.DB)).toBe(0);
    await replaceTilePlaces(env.DB, KA, ["1"], NOW, false);
    expect(await tilesChangedAt(env.DB)).toBe(NOW);
  });

  it("R11/R4: 격자 ID가 바뀔 때마다 tiles_changed_at은 반드시 커진다 — 같은 now로 두 번 바뀌어도, 더 이른 now가 늦게 와도 (커서가 같은 값으로 속지 않게)", async () => {
    await replaceTilePlaces(env.DB, KA, ["1"], NOW, false);
    const a = await tilesChangedAt(env.DB);
    await replaceTilePlaces(env.DB, KA, ["1", "2"], NOW, false);
    const b = await tilesChangedAt(env.DB);
    expect(b).toBeGreaterThan(a);
    await replaceTilePlaces(env.DB, KA, ["1", "2", "3"], NOW - 60_000, false);
    const c = await tilesChangedAt(env.DB);
    expect(c).toBeGreaterThan(b);
    // ID가 그대로면(수집 시각만) 바꾸지 않는다
    await replaceTilePlaces(env.DB, KA, ["1", "2", "3"], NOW + 5_000, false);
    expect(await tilesChangedAt(env.DB)).toBe(c);
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

  it("R10/R63: 상세가 필요한 ID를 격자 거리순(같으면 id순)으로, 갱신 기준을 지키며, limit만큼", async () => {
    await replaceTilePlaces(env.DB, KA, ["a1", "fresh", "oldok", "recentfail"], NOW, false);
    await replaceTilePlaces(env.DB, KB, ["b1"], NOW, false);
    // 3일(예전 TTL)이 지났어도 이번 갱신 시작 뒤에 가져왔으면 대상이 아니다
    await seedPlace(env.DB, "fresh", ASEM.lat, ASEM.lng, { now: START });
    await seedPlace(env.DB, "oldok", ASEM.lat, ASEM.lng, { now: START - 1 });
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

describe("Task 34: 보충 후보를 SQL에서 가까운 순으로 고르기", () => {
  const KEYS = tilesCoveringCircle(ASEM, 1000);
  /** 거점 밖 기준점 (관리자 warm의 임의 좌표) — ok는 예전 규칙(3일 + 지터)이라 SQL이 지터를 볼 수 없다 */
  const OUTSIDE = { lat: ASEM.lat + 0.3, lng: ASEM.lng };
  const KO = tileKeyOf(OUTSIDE);
  const OUT_KEYS = tilesCoveringCircle(OUTSIDE, 1000);
  /** 칸 중심까지 거리 (repo의 순위와 같은 계산) */
  const tileDist = (k: string, c: LatLng = ASEM) => {
    const r = tileRect(k);
    return haversine(c, { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 });
  };
  /** 결정적인 난수 (테스트마다 같은 데이터) */
  const lcg = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x1_0000_0000);

  type Seed = { id: string; tiles: string[]; status?: "ok" | "failed"; fetchedAt?: number };
  async function seedStates(rows: Seed[]) {
    const places = rows.filter((r) => r.status).map((r) => [r.id, r.status, r.fetchedAt, r.status === "failed" ? "http_500" : null]);
    for (let i = 0; i < places.length; i += 200) {
      await env.DB.prepare(
        `INSERT INTO places (id, status, fetched_at, fail_reason)
         SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]') FROM json_each(?)`,
      ).bind(JSON.stringify(places.slice(i, i + 200))).run();
    }
    const tp = rows.flatMap((r) => r.tiles.map((k) => [k, r.id]));
    for (let i = 0; i < tp.length; i += 500) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO tile_places (tile_key, place_id) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)",
      ).bind(JSON.stringify(tp.slice(i, i + 500))).run();
    }
  }

  /** 미수집·신선한 ok·지터 창 안(만료 전/후)·오래된 ok·신선한/만료된 실패를 섞고, 일부 ID는 2~3칸에 기록한다 */
  function mixedRows(n: number, rand: () => number, keys = KEYS): Seed[] {
    return Array.from({ length: n }, (_, i) => {
      const id = String(10_000 + Math.floor(rand() * 90_000) * 10 + (i % 10));
      const tiles = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => keys[Math.floor(rand() * keys.length)]))];
      const kind = Math.floor(rand() * 7);
      const j = detailJitterMs(id);
      const fetchedAt = [
        undefined,
        NOW - 1000,
        NOW - DETAIL_OK_TTL_MS - j + 1, // 지터 창 안, 아직 아님
        NOW - DETAIL_OK_TTL_MS - j, // 지터 창 안, 막 만료
        NOW - DETAIL_OK_TTL_MS - DETAIL_JITTER_MS - 5,
        NOW - DETAIL_FAIL_TTL_MS + 1,
        NOW - DETAIL_FAIL_TTL_MS,
      ][kind];
      const status = kind === 0 ? undefined : kind >= 5 ? "failed" : "ok";
      return { id, tiles, status, fetchedAt } as Seed;
    });
  }

  it("R10/R63: 보충 대상(limit 있음)을 SQL에서 가까운 순으로 고른 결과가 격자 상태를 다 읽어 고른 결과(pickDetailIds)와 같다 — due·unfetched, 여러 칸에 기록된 ID, 지터 경계(거점 밖)·갱신 시작 경계(거점)", async () => {
    for (const [center, keys, seed] of [[ASEM, KEYS, 11], [OUTSIDE, OUT_KEYS, 12]] as const) {
      const rows = mixedRows(400, lcg(seed), keys);
      // 거점 칸: 갱신 시작 바로 전·정각도 섞는다
      rows.slice(0, 40).forEach((r, i) => Object.assign(r, { status: "ok", fetchedAt: i % 2 ? START - 1 : START }));
      await seedStates(rows);
      const all = await tilePlaceStates(env.DB, keys);
      for (const scope of ["due", "unfetched"] as const) {
        for (const limit of [1, 3, 10, 37, 1000]) {
          const want = pickDetailIds(all, center, NOW, limit, scope);
          expect(want.length, `${scope} ${limit}`).toBeGreaterThan(0);
          expect(await idsNeedingDetail(env.DB, center, 1000, NOW, limit, scope), `${scope} ${limit}`).toEqual(want);
        }
      }
    }
  });

  it("R10/R38: (거점 밖 칸) 가까운 칸에 아직 만료되지 않은(지터 창 안) 행이 한 쪽보다 많아도 다음 쪽을 읽어 같은 ID를 고르고, 읽어 오는 행은 쪽 단위다", async () => {
    // 가장 가까운 칸(KO)에 지터 창 안·아직 아닌 ok 행을 한 쪽보다 많이, 그 뒤 칸에 미수집 몇 곳
    // 첫 두 쪽보다 많이 — 세 번째 쪽에서 찾는다
    const near = Array.from({ length: DETAIL_PICK_FIRST_PAGE * (1 + DETAIL_PICK_GROWTH) + 30 }, (_, i) => `n${String(i).padStart(4, "0")}`);
    const far = OUT_KEYS.find((k) => k !== KO)!;
    await seedStates([
      ...near.map((id) => ({ id, tiles: [KO], status: "ok" as const, fetchedAt: NOW - DETAIL_OK_TTL_MS - detailJitterMs(id) + 1 })),
      { id: "zfar1", tiles: [far] },
      { id: "zfar2", tiles: [far] },
      { id: "nlate", tiles: [KO], status: "ok", fetchedAt: NOW - DETAIL_OK_TTL_MS - DETAIL_JITTER_MS },
    ]);
    const want = pickDetailIds(await tilePlaceStates(env.DB, OUT_KEYS), OUTSIDE, NOW, 3, "due");
    expect(want).toEqual(["nlate", "zfar1", "zfar2"]);
    expect(await idsNeedingDetail(env.DB, OUTSIDE, 1000, NOW, 3, "due")).toEqual(want);
    // 전체를 읽는 길(limit 없음, warm count=1)은 그대로다
    expect(await idsNeedingDetail(env.DB, OUTSIDE, 1000, NOW)).toEqual(want);
  });

  it("R63/R38: 거점 칸은 갱신 시작 뒤에 가져온 ok를 SQL이 거른다 — 그런 행이 아무리 많아도 한 쪽만 읽고, 고른 결과는 pickDetailIds와 같다", async () => {
    const near = Array.from({ length: DETAIL_PICK_FIRST_PAGE * (1 + DETAIL_PICK_GROWTH) + 30 }, (_, i) => `n${String(i).padStart(4, "0")}`);
    const far = KEYS.find((k) => k !== KA)!;
    await seedStates([
      ...near.map((id) => ({ id, tiles: [KA], status: "ok" as const, fetchedAt: START + 1 })),
      { id: "zfar1", tiles: [far] },
      { id: "nold", tiles: [KA], status: "ok", fetchedAt: START - 1 },
    ]);
    const { db, log } = recordingDb(env.DB);
    const want = pickDetailIds(await tilePlaceStates(env.DB, KEYS), ASEM, NOW, 3, "due");
    expect(want).toEqual(["nold", "zfar1"]);
    expect(await idsNeedingDetail(db, ASEM, 1000, NOW, 3, "due")).toEqual(want);
    expect(log.filter((x) => x.sql === NEAREST_DUE_SQL)).toHaveLength(1);
  });

  it("R10/R11: 한 가게가 여러 칸에 기록돼 한 쪽 안의 서로 다른 가게가 limit보다 적어도 다음 쪽을 읽어 같은 결과다 (가게마다 가장 가까운 칸)", async () => {
    // 기준점을 KA와 오른쪽 칸의 경계에 두면 두 칸이 같은 순위다 — 두 칸에 다 기록된 가게는 같은 순위 안에서 행이 두 개씩 나온다
    const [i, j] = KA.split(":").map(Number);
    const r = tileRect(KA);
    const center = { lat: (r.minLat + r.maxLat) / 2, lng: r.maxLng };
    const keys = tilesCoveringCircle(center, 1000);
    const two = [KA, `${i}:${j + 1}`];
    await seedStates(Array.from({ length: 80 }, (_, k) => ({ id: `m${String(k).padStart(3, "0")}`, tiles: [...two, `${i + 2}:${j}`] })));
    const limit = 60;
    expect(limit * two.length).toBeGreaterThan(Math.max(limit, DETAIL_PICK_FIRST_PAGE)); // 첫 쪽(100행)에는 서로 다른 가게가 50곳뿐
    const all = await tilePlaceStates(env.DB, keys);
    expect(await idsNeedingDetail(env.DB, center, 1000, NOW, limit)).toEqual(pickDetailIds(all, center, NOW, limit, "due"));
    const { states: nearest } = await nearestUnfetchedStates(env.DB, keys, [center], limit);
    expect(nearest).toHaveLength(limit);
    expect(nearest.map((t) => t.id)).toEqual(pickDetailIds(all, center, NOW, limit, "unfetched"));
    // 돌려준 칸은 그 가게가 기록된 칸 중 가장 가까운 칸 (같은 순위 둘 중 하나)
    expect(nearest.every((t) => two.includes(t.tileKey))).toBe(true);
  });

  it("R38: 가까운 순 후보 조회는 칸마다 tile_places 기본 키로, 가게는 places 기본 키로 찾는다 (표 전체 스캔 없음)", async () => {
    for (const [sql, ranked, extra] of [[NEAREST_DUE_SQL, '[["1:1",0,0]]', [NOW]], [NEAREST_UNFETCHED_SQL, '[["1:1",0]]', []]] as const) {
      const r = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(ranked, 10, 0, ...extra).all<{ detail: string }>();
      const plan = r.results.map((x) => x.detail).join("\n");
      expect(plan).toMatch(/SEARCH tp USING COVERING INDEX sqlite_autoindex_tile_places_1 \(tile_key=\?\)/);
      expect(plan).toMatch(/SEARCH p USING INDEX sqlite_autoindex_places_1 \(id=\?\)/);
      expect(plan).not.toMatch(/SCAN (tp|p)\b/);
    }
  });

  it("R10: limit이 있으면 격자 상태를 다 받아 오지 않는다 — 돌려받는 행은 고른 ID와 쪽 크기만큼", async () => {
    await seedStates(Array.from({ length: 500 }, (_, i) => ({ id: `u${i}`, tiles: [KEYS[i % KEYS.length]] })));
    const { db, log } = recordingDb(env.DB);
    const rowsBack: number[] = [];
    const counting = new Proxy(db, {
      get(t, k) {
        if (k !== "prepare") return Reflect.get(t, k);
        return (sql: string) => {
          const st = t.prepare(sql);
          const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(s, {
              get(x, m) {
                if (m === "bind") return (...v: unknown[]) => wrap(x.bind(...v));
                if (m === "all") return async () => { const r = await x.all(); rowsBack.push(r.results.length); return r; };
                return Reflect.get(x, m);
              },
            });
          return wrap(st);
        };
      },
    });
    expect(await idsNeedingDetail(counting, ASEM, 1000, NOW, 10)).toHaveLength(10);
    expect(log.length).toBeGreaterThan(0);
    expect(rowsBack.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(DETAIL_PICK_FIRST_PAGE);
  });

  it("R11: Cron은 미수집 ID를 가까운 순 limit개만 읽어 만료 후보와 합쳐도, 미수집 전부를 합쳐 고른 것과 같은 ID를 고른다 (여러 거점 기준)", async () => {
    const centers: LatLng[] = [ASEM, HUBS.find((h) => h.id === "gangnam")!];
    const keys = [...new Set(centers.flatMap((c) => tilesCoveringCircle(c, 1000)))];
    await seedStates(mixedRows(500, lcg(23), keys));
    const expired = await expiredDetailStates(env.DB, keys, NOW);
    const unfetched = await unfetchedStates(env.DB, keys);
    for (const limit of [1, 4, 10, 60]) {
      const { states: nearest } = await nearestUnfetchedStates(env.DB, keys, centers, limit);
      expect(nearest.length).toBeLessThanOrEqual(limit);
      expect(nearest.every((t) => t.meta === null)).toBe(true);
      expect(pickDetailIds([...expired, ...nearest], centers, NOW, limit, "due"), String(limit)).toEqual(
        pickDetailIds([...expired, ...unfetched], centers, NOW, limit, "due"),
      );
    }
    // 미수집이 없으면 빈 배열 (Cron의 "미수집 다 채움" 표시)
    await env.DB.prepare("DELETE FROM tile_places WHERE place_id NOT IN (SELECT id FROM places)").run();
    expect(await nearestUnfetchedStates(env.DB, keys, centers, 10)).toEqual({ states: [], cleared: true });
  });

  it("R10/R38: (거점 밖 칸) 후보 쪽은 커지며 많아야 DETAIL_PICK_MAX_PAGES쪽만 읽는다 — 못 채우면 truncated로 알리고 그때까지 고른 것을 돌려준다", async () => {
    let total = 0;
    for (let i = 0, page = Math.max(3, DETAIL_PICK_FIRST_PAGE); i < DETAIL_PICK_MAX_PAGES; i++, page *= DETAIL_PICK_GROWTH) total += page;
    const near = Array.from({ length: total + 5 }, (_, i) => `n${String(i).padStart(5, "0")}`);
    const far = [...OUT_KEYS].sort((a, b) => tileDist(b, OUTSIDE) - tileDist(a, OUTSIDE))[0];
    await seedStates([
      ...near.map((id) => ({ id, tiles: [KO], status: "ok" as const, fetchedAt: NOW - DETAIL_OK_TTL_MS - detailJitterMs(id) + 1 })),
      { id: "zfar", tiles: [far] },
    ]);
    const { db, log } = recordingDb(env.DB);
    expect(await nearestDetailIds(db, OUTSIDE, 1000, NOW, 3)).toEqual({ ids: [], truncated: true });
    expect(log.filter((x) => x.sql === NEAREST_DUE_SQL)).toHaveLength(DETAIL_PICK_MAX_PAGES);
    // 전체를 읽는 길(warm count=1)은 상한이 없다
    expect(await idsNeedingDetail(env.DB, OUTSIDE, 1000, NOW)).toEqual(["zfar"]);
  });

  it("R11: 수집할 격자(없음·만료)만 SQL로 고른 결과가 getTiles + isTileDue와 같고 keys 순서를 지킨다", async () => {
    const keys = tilesCoveringCircle(ASEM, 1000);
    const rand = lcg(5);
    for (const k of keys) {
      const kind = Math.floor(rand() * 4);
      if (kind === 0) continue; // 없음
      const at = [0, NOW - 1000, NOW - TILE_TTL_MS + 1, NOW - TILE_TTL_MS][kind];
      await markTile(env.DB, k, at, 0, false);
    }
    const states = await getTiles(env.DB, keys);
    const want = keys.filter((k) => isTileDue(k, states.get(k), NOW));
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThan(keys.length);
    expect(await dueTileKeys(env.DB, keys, NOW)).toEqual(want);
    expect(await dueTileKeys(env.DB, [...keys].reverse(), NOW)).toEqual([...want].reverse());
    expect(await dueTileKeys(env.DB, [], NOW)).toEqual([]);
  });

  /** Cron 앞선 커서 테스트용: 거점 1000m 칸마다 상세가 있는 가게 3곳 + 가장 먼 칸에 미수집 */
  async function seedFrontier(keys: string[], unfetched: Record<string, string>) {
    await seedStates([
      ...keys.flatMap((k, i) => [0, 1, 2].map((n) => ({ id: `ok${i}_${n}`, tiles: [k], status: "ok" as const, fetchedAt: NOW - 1000 }))),
      ...Object.entries(unfetched).map(([id, k]) => ({ id, tiles: [k] })),
    ]);
  }
  const readsOf = (log: { read: number }[]) => log.reduce((n, x) => n + x.read, 0);
  const oracle = async (keys: string[], centers: LatLng[], limit: number) =>
    pickDetailIds(await unfetchedStates(env.DB, keys), centers, NOW, limit, "unfetched");
  const ids = (p: { states: { id: string }[] }) => p.states.map((t) => t.id);

  it("R11/R38: Cron 미수집은 앞선 커서(unfetched_from)부터 읽는다 — 다음 실행은 앞선 묶음만 읽고, 다 채우면 cleared 뒤로는 후보 조회를 하지 않는다", async () => {
    const byDist = [...KEYS].sort((a, b) => tileDist(a) - tileDist(b));
    const far = byDist[byDist.length - 1];
    expect(KEYS.length).toBeGreaterThan(UNFETCHED_CHUNK_TILES); // 묶음이 두 개 이상
    await seedFrontier(KEYS, { u1: far, u2: far });
    const run = async () => {
      const { db, log } = recordingDb(env.DB);
      const r = await nearestUnfetchedStates(db, KEYS, [ASEM], 4);
      return { r, read: readsOf(log), queries: log.filter((x) => x.sql === NEAREST_UNFETCHED_SQL).length };
    };
    const first = await run();
    expect(ids(first.r)).toEqual(await oracle(KEYS, [ASEM], 4));
    expect(ids(first.r)).toEqual(["u1", "u2"]);
    expect(first.r.cleared).toBe(false);
    expect(first.queries).toBeGreaterThan(1);
    const cursor = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(UNFETCHED_FROM_KEY).first<{ value: string }>();
    expect(JSON.parse(cursor!.value)).toMatchObject({ rank: expect.any(Number), changedAt: 0, keys: expect.any(String) });

    const second = await run();
    expect(second.r).toEqual(first.r);
    expect(second.queries).toBe(1);
    expect(second.read).toBeLessThan(first.read / 2);

    // 채우면 끝까지 읽고 cleared, 그 뒤로는 후보 조회 없이 cleared
    for (const id of ["u1", "u2"]) await seedPlace(env.DB, id, ASEM.lat, ASEM.lng, { now: NOW });
    const third = await run();
    expect(third.r).toEqual({ states: [], cleared: true });
    const fourth = await run();
    expect(fourth.r).toEqual({ states: [], cleared: true });
    expect(fourth.queries).toBe(0);
  });

  it("R11/R4: 커서를 쓴 뒤 같은 now로 격자 ID가 또 들어와도 커서를 버린다 (tiles_changed_at이 같은 값으로 머물지 않는다)", async () => {
    const byDist = [...KEYS].sort((a, b) => tileDist(a) - tileDist(b));
    const far = byDist[byDist.length - 1];
    await seedFrontier(KEYS, {});
    // 앱 길로 먼 칸에 미수집을 넣고(tiles_changed_at = NOW) 커서를 그 값으로 쓴다
    const farIds = (await env.DB.prepare("SELECT place_id FROM tile_places WHERE tile_key = ?").bind(far).all<{ place_id: string }>())
      .results.map((x) => x.place_id);
    await replaceTilePlaces(env.DB, far, [...farIds, "u1"], NOW, false);
    expect(ids(await nearestUnfetchedStates(env.DB, KEYS, [ASEM], 4))).toEqual(["u1"]);
    // 같은 now로 가까운 칸에 새 ID
    const near = byDist[0];
    const cur = (await env.DB.prepare("SELECT place_id FROM tile_places WHERE tile_key = ?").bind(near).all<{ place_id: string }>())
      .results.map((x) => x.place_id);
    await replaceTilePlaces(env.DB, near, [...cur, "newnear"], NOW, false);
    expect(ids(await nearestUnfetchedStates(env.DB, KEYS, [ASEM], 4))).toEqual(["newnear", "u1"]);
  });

  it("R11/R4: 격자에 ID가 새로 들어오면(replaceTilePlaces → tiles_changed_at) 커서를 버리고 처음부터 읽는다 — 가까운 새 ID를 놓치지 않는다", async () => {
    const byDist = [...KEYS].sort((a, b) => tileDist(a) - tileDist(b));
    await seedFrontier(KEYS, { u1: byDist[byDist.length - 1] });
    expect(ids(await nearestUnfetchedStates(env.DB, KEYS, [ASEM], 4))).toEqual(["u1"]);
    const near = byDist[0];
    const cur = (await env.DB.prepare("SELECT place_id FROM tile_places WHERE tile_key = ?").bind(near).all<{ place_id: string }>())
      .results.map((x) => x.place_id);
    await replaceTilePlaces(env.DB, near, [...cur, "newnear"], NOW + 1, false);
    const r = await nearestUnfetchedStates(env.DB, KEYS, [ASEM], 4);
    expect(ids(r)).toEqual(["newnear", "u1"]);
    expect(ids(r)).toEqual(await oracle(KEYS, [ASEM], 4));
  });

  it("R11: 거점(격자 집합·기준점)이 바뀌면 커서를 버리고 처음부터 읽는다", async () => {
    const gangnam = HUBS.find((h) => h.id === "gangnam")!;
    const byDist = [...KEYS].sort((a, b) => tileDist(a) - tileDist(b));
    await seedFrontier(KEYS, { u1: byDist[byDist.length - 1] });
    await seedStates([{ id: "g0", tiles: [tileKeyOf(gangnam)] }]);
    expect(ids(await nearestUnfetchedStates(env.DB, KEYS, [ASEM], 4))).toEqual(["u1"]);
    // 거점 추가: 격자 집합이 바뀐다
    const both = [...new Set([...KEYS, ...tilesCoveringCircle(gangnam, 1000)])];
    const r = await nearestUnfetchedStates(env.DB, both, [ASEM, gangnam], 4);
    expect(ids(r)).toEqual(await oracle(both, [ASEM, gangnam], 4));
    expect(ids(r)[0]).toBe("g0");
    // 격자 집합은 같고 기준점만 바뀌어도 순위가 바뀌므로 처음부터
    const north = { lat: ASEM.lat + 0.008, lng: ASEM.lng };
    expect(ids(await nearestUnfetchedStates(env.DB, both, [ASEM, gangnam], 4))).toEqual(await oracle(both, [ASEM, gangnam], 4));
    expect(ids(await nearestUnfetchedStates(env.DB, both, [north, gangnam], 4))).toEqual(await oracle(both, [north, gangnam], 4));
  });

  it("R11/R38: 한 실행은 많아야 UNFETCHED_MAX_CHUNKS묶음만 읽고(순위 묶음은 쪼개지 않는다) 못 찾으면 다음 실행이 이어 읽는다 — cleared는 끝까지 읽었을 때만", async () => {
    const hubs = HUBS.filter((h) => ["bongeunsa", "ddp", "pangyo", "naebang"].includes(h.id));
    const keys = [...new Set(hubs.flatMap((h) => tilesCoveringCircle(h, 1000)))];
    expect(keys.length).toBeGreaterThan(UNFETCHED_CHUNK_TILES * UNFETCHED_MAX_CHUNKS);
    const dist = (k: string) => Math.min(...hubs.map((h) => tileDist(k, h)));
    const far = [...keys].sort((a, b) => dist(b) - dist(a))[0];
    await seedStates([{ id: "lonely", tiles: [far] }]);
    const run = async () => {
      const { db, log } = recordingDb(env.DB);
      const r = await nearestUnfetchedStates(db, keys, hubs, 4);
      return { r, queries: log.filter((x) => x.sql === NEAREST_UNFETCHED_SQL).length };
    };
    const first = await run();
    expect(first).toEqual({ r: { states: [], cleared: false }, queries: UNFETCHED_MAX_CHUNKS });
    const second = await run();
    expect(ids(second.r)).toEqual(["lonely"]);
    expect(second.r.cleared).toBe(false);
    await seedPlace(env.DB, "lonely", ASEM.lat, ASEM.lng, { now: NOW });
    expect((await run()).r).toEqual({ states: [], cleared: true });
    // limit 0이면 읽지 않고 cleared도 아니다 (Cron batchSize 0)
    expect(await nearestUnfetchedStates(env.DB, keys, hubs, 0)).toEqual({ states: [], cleared: false });
  });

  it("R10: 칸 중심 거리가 같은 두 칸의 가게는 id순 — SQL 순위와 pickDetailIds가 같은 동점 처리를 한다", async () => {
    // 기준점을 두 칸의 경계(경도)에 두면 좌우 칸 중심까지 거리가 같다
    const [i, j] = KA.split(":").map(Number);
    const r = tileRect(KA);
    const center = { lat: (r.minLat + r.maxLat) / 2, lng: r.maxLng };
    const left = KA;
    const right = `${i}:${j + 1}`;
    await seedStates([{ id: "b", tiles: [left] }, { id: "a", tiles: [right] }, { id: "c", tiles: [left] }]);
    const want = pickDetailIds(await tilePlaceStates(env.DB, tilesCoveringCircle(center, 300)), center, NOW, 10, "due");
    expect(want.slice(0, 3)).toEqual(["a", "b", "c"]);
    expect(await idsNeedingDetail(env.DB, center, 300, NOW, 10)).toEqual(want);
  });
});

describe("Task 34: 상세 저장을 batch 하나로", () => {
  const hub = (id: string) => HUBS.find((h) => h.id === id)!;
  const BONG = hub("bongeunsa");
  const fixtures = import.meta.glob("../fixtures/place-detail/*.json", { eager: true, import: "default" });
  /** 실제 상세 픽스처 12개를 봉은사역 근처 좌표로 (가게마다 다른 메뉴·영업시간·태그) */
  const parsedNearBong = Object.values(fixtures).map((raw, k) => {
    const o = raw as { summary: Record<string, unknown> };
    const r = parseDetail({ ...o, summary: { ...o.summary, point: { lat: BONG.lat + (k - 6) * 0.0006, lon: BONG.lng + (k - 6) * 0.0007 } } });
    if (!r.ok) throw new Error("fixture");
    return r;
  });

  /** 저장 전 상태: 강남역에 있던 "move"(봉은사로 옮겨진다), 판교역의 "failold"(실패로 바뀐다) */
  async function preState() {
    await seedPlace(env.DB, "move", hub("gangnam").lat, hub("gangnam").lng, { now: NOW - 10 });
    await seedPlace(env.DB, "failold", hub("pangyo").lat, hub("pangyo").lng, { now: NOW - 10 });
    await env.DB.prepare("DELETE FROM meta WHERE key LIKE ?").bind(`${SNAPSHOT_DIRTY_PREFIX}%`).run();
  }
  const saves = (): DetailSave[] => [
    ...parsedNearBong.map((r, k) => ({ id: `b${k}`, summary: r.summary, detail: r.detail })),
    { id: "move", summary: parsedNearBong[0].summary, detail: parsedNearBong[0].detail },
    { id: "far", summary: { ...parsedNearBong[1].summary, lat: 35.1, lng: 129.0 }, detail: parsedNearBong[1].detail },
    { id: "failold", reason: "http_500" },
    { id: "failnew", reason: "http_404" },
  ];
  const dump = async () => ({
    places: (await env.DB.prepare("SELECT * FROM places ORDER BY id").all()).results,
    stamped: (await env.DB.prepare("SELECT key FROM meta WHERE key LIKE ? ORDER BY key").bind(`${SNAPSHOT_DIRTY_PREFIX}%`).all<{ key: string }>())
      .results.map((x) => x.key.slice(SNAPSHOT_DIRTY_PREFIX.length)),
  });
  const keys = tilesCoveringCircle(BONG, 1000);
  const listBody = async () => {
    const { rows } = await readList(env.DB, BONG, 1000, keys);
    const { items, ...meta } = placesPayload(BONG, 1000, rows, {
      pending: 0, incompleteTiles: 0, stale: false, detailsPaused: false, detailsFrozenSince: null, refreshedAt: null, refreshDay: 1,
    });
    return placesBody(meta, items);
  };

  it("R12/R56: 여러 곳의 상세·실패를 한 batch로 저장한 행(list_json 포함)·목록 본문(글자까지)·표시가 오른 거점이 한 곳씩 saveDetail·saveDetailFailure로 저장한 것과 같다", async () => {
    // 목록에 보이게 모든 ID를 봉은사 격자 한 칸에 기록한다
    await replaceTilePlaces(env.DB, keys[0], saves().map((x) => x.id), NOW - 100, false);
    await preState();
    const batches: number[] = [];
    const db = new Proxy(env.DB, {
      get(t, k) {
        if (k === "batch") return async (st: D1PreparedStatement[]) => { batches.push(st.length); return t.batch(st); };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await saveDetails(db, saves(), NOW);
    expect(batches).toHaveLength(1);
    const batched = await dump();
    const batchedBody = await listBody();

    await env.DB.prepare("DELETE FROM places").run();
    await preState();
    for (const x of saves()) {
      if ("reason" in x) await saveDetailFailure(env.DB, x.id, x.reason, NOW);
      else await saveDetail(env.DB, x.id, x.summary, x.detail, NOW);
    }
    const oneByOne = await dump();
    expect(batched.places).toHaveLength(parsedNearBong.length + 4);
    expect(batched.places).toEqual(oneByOne.places);
    expect(batchedBody).toBe(await listBody());
    expect(JSON.parse(batchedBody).places.length).toBeGreaterThanOrEqual(parsedNearBong.length);
    // 옮긴 가게의 예전 거점(강남, 강남역 자리는 역삼역 반경에도 든다)·새 거점(봉은사), 표시 정보가 남은 실패 행의 거점(판교).
    // 먼 가게·처음 실패한 가게는 없음
    expect(batched.stamped).toEqual(["bongeunsa", "gangnam", "pangyo", "samseong", "seolleung", "yeoksam"]);
    expect(batched.stamped).toEqual(oneByOne.stamped);
  });

  it("R56: batch 저장은 거점마다 표시를 한 번 올리고, 같은 ms·앞선 값이어도 저장 전보다 커진다", async () => {
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind(`${SNAPSHOT_DIRTY_PREFIX}bongeunsa`, String(NOW + 500)).run();
    await saveDetails(env.DB, saves().slice(0, 3), NOW);
    const v = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(`${SNAPSHOT_DIRTY_PREFIX}bongeunsa`).first<{ value: string }>();
    expect(Number(v?.value)).toBe(NOW + 501);
  });

  it("R56/R38: 여러 곳의 거점 표시 문장은 가게를 기본 키로 찾는다 (좌표 인덱스 idx_places_lat_lng로 훑지 않는다)", async () => {
    // 좌표 인덱스가 유리해 보이게 행을 넣고 통계를 만든 뒤에도
    await seedMany(Array.from({ length: 300 }, (_, i) => [`s${i}`, NOW] as [string, number]));
    await env.DB.prepare("ANALYZE").run();
    const r = await env.DB.prepare(`EXPLAIN QUERY PLAN ${MARK_PLACES_DIRTY_SQL}`)
      .bind("1", '[["bongeunsa",37,38,127,128]]', "[]", '["s1","s2"]').all<{ detail: string }>();
    const plan = r.results.map((x) => x.detail).join("\n");
    expect(plan).toMatch(/SEARCH p USING INDEX sqlite_autoindex_places_1 \(id=\?\)/);
    expect(plan).not.toMatch(/idx_places_lat_lng/);
  });

  it("R10: 저장할 것이 없으면 D1을 부르지 않는다", async () => {
    const { db, log } = recordingDb(env.DB);
    await saveDetails(db, [], NOW);
    expect(log).toEqual([]);
  });
});
