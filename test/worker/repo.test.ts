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
  EXPIRED_RESET_PAGES, EXPIRED_SCAN_LIMIT, EXPIRED_SCAN_SQL, LIST_BACKFILL_LIMIT, backfillListJson,
} from "../../worker/repo";
import { LIST_JSON_PREFIX, storedListJson } from "../../worker/present";
import { makeSummary, sampleDetail, seedPlace } from "../helpers/places";
import { recordingDb } from "../helpers/recordDb";

const NOW = 1_800_000_000_000;
const KA = tileKeyOf(ASEM);
const [I, J] = KA.split(":").map(Number);
const KB = `${I + 3}:${J}`; // 약 750m 북쪽 격자

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

  it("R11/R38: 만료 후보는 상태별로 fetched_at이 오래된 순 300개까지만 고른다", async () => {
    const ids = Array.from({ length: 310 }, (_, i) => `k${i}`);
    await seedMany(ids.map((id, i) => [id, NOW - DETAIL_OK_TTL_MS - (310 - i)]));
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
    await seedMany([["h1", NOW - DETAIL_OK_TTL_MS - 3], ["h2", NOW - DETAIL_OK_TTL_MS - 2]]);
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
    // 요청 하나가 Cron보다 먼저 시각을 잡고 늦게 격자를 기록했다 (tiles_changed_at < 커서를 쓴 시각)
    await replaceTilePlaces(env.DB, KA, ["h1", "h2", "o5"], NOW - 60_000, false);
    expect(await tilesChangedAt(env.DB)).toBe(NOW - 60_000);
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
