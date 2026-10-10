import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DETAIL_FAIL_TTL_MS, DETAIL_OK_TTL_MS, PREWARM_RADIUS, TILE_TTL_MS } from "../../shared/constants";
import { haversine, tileKeyOf, tileRect, tilesCoveringCircle } from "../../shared/geo";
import { HUBS, hubById, type Hub } from "../../shared/hubs";
import { HUB_DUE_EXISTS_SQL, HUB_REFRESHED_PREFIX, hubHasDue, readHubRefreshed } from "../../worker/hubRefresh";
import { CRON_INTERVAL_MS, hubOrder, pickRefreshCheck, runScheduled } from "../../worker/maintenance";
import { dueSinceOf, hubRefreshStart as refreshStartOf, tileFreshFrom, tileRefreshStart, tileRefreshStarts } from "../../worker/refreshSchedule";
import {
  EXPIRED_RESET_PAGES, EXPIRED_SCAN_LIMIT, detailJitterMs, dueTileKeys, expiredDetailStates, getTiles, isPlaceDue, isTileDue, markTile, pickCronIds,
  replaceTilePlaces, saveDetailFailure, type DetailMeta, type TilePlaceState,
} from "../../worker/repo";
import { SNAPSHOT_DIRTY_PREFIX } from "../../worker/snapshotDirty";
import { doc, fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { placeJson } from "../helpers/places";
import { recordingDb } from "../helpers/recordDb";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** KST 시각 → epoch ms */
const kst = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
/** 2026-10-07 수요일 10:00 KST */
const NOW = kst(2026, 10, 7, 10);
const BONG = hubById("bongeunsa"); // 월
const DDP = hubById("ddp"); // 화
const S_BONG = kst(2026, 10, 5);
const S_DDP = kst(2026, 10, 6);
const S_WED = kst(2026, 10, 7);
const KB = tileKeyOf(BONG);
const KD = tileKeyOf(DDP);
/** 어느 거점도 덮지 않는 격자 */
const OUT = "1:1";
const OUT2 = "1:2";
const ALL_KEYS = [...new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)))];

const ok = (fetchedAt: number): NonNullable<DetailMeta> => ({ status: "ok", fetchedAt, reason: null });
const failed = (fetchedAt: number): NonNullable<DetailMeta> => ({ status: "failed", fetchedAt, reason: "http_500" });

/** [id, fetched_at] 여러 개를 상세 ok로 (좌표는 봉은사) */
async function seedOk(rows: [string, number][]) {
  for (let i = 0; i < rows.length; i += 200) {
    await env.DB.prepare(
      `INSERT INTO places (id, status, name, category_name, category_group, lat, lng, fetched_at)
       SELECT json_extract(value, '$[0]'), 'ok', '가게', '음식점 > 한식', 'korean', ?, ?, json_extract(value, '$[1]') FROM json_each(?)`,
    ).bind(BONG.lat, BONG.lng, JSON.stringify(rows.slice(i, i + 200))).run();
  }
}
async function markFresh(keys: string[], at: number) {
  for (let i = 0; i < keys.length; i += 200) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO tiles (key, collected_at, place_count, saturated) SELECT value, ?, 0, 0 FROM json_each(?)",
    ).bind(at, JSON.stringify(keys.slice(i, i + 200))).run();
  }
}
/** 거점에서 칸 중심이 먼 순 */
const farthest = (hub: Hub) => {
  const d = (k: string) => {
    const r = tileRect(k);
    return haversine(hub, { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 });
  };
  return [...tilesCoveringCircle(hub, PREWARM_RADIUS)].sort((a, b) => d(b) - d(a));
};
const refreshedMeta = async (hub: string) => {
  const r = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(HUB_REFRESHED_PREFIX + hub).first<{ value: string }>();
  return r ? (JSON.parse(r.value) as unknown) : null;
};
const stamp = async (hub: string) =>
  Number((await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT_DIRTY_PREFIX + hub).first<{ value: string }>())?.value ?? 0);

describe("R63 갱신 대상 판단", () => {
  it("R63: 거점 격자의 ok 상세는 그 거점 갱신 시작 전에 가져왔을 때만 대상 — 실패는 6시간, 미수집은 언제나, 거점 밖 격자는 예전처럼 3일 + 지터", () => {
    expect(tileRefreshStart(KB, NOW)).toBe(S_BONG);
    expect(tileRefreshStart(KD, NOW)).toBe(S_DDP);
    expect(tileRefreshStart(OUT, NOW)).toBeNull();
    expect(isPlaceDue(ok(S_BONG - 1), KB, NOW, "a")).toBe(true);
    expect(isPlaceDue(ok(S_BONG), KB, NOW, "a")).toBe(false);
    // 3일(예전 TTL)이 지나도 시작 뒤에 가져왔으면 대상이 아니고, 다음 주 같은 요일 00:00부터 대상
    expect(isPlaceDue(ok(S_BONG + 1), KB, S_BONG + 7 * DAY - 1, "a")).toBe(false);
    expect(isPlaceDue(ok(S_BONG + 1), KB, S_BONG + 7 * DAY, "a")).toBe(true);
    // 다 못 하면 다음 날로 이어진다 (시작이 지나도 그대로 대상)
    expect(isPlaceDue(ok(S_BONG - 1), KB, S_BONG + 3 * DAY, "a")).toBe(true);
    expect(isPlaceDue(failed(NOW - DETAIL_FAIL_TTL_MS), KB, NOW, "a")).toBe(true);
    expect(isPlaceDue(failed(NOW - DETAIL_FAIL_TTL_MS + 1), KB, NOW, "a")).toBe(false);
    expect(isPlaceDue(null, KB, NOW, "a")).toBe(true);
    const j = detailJitterMs("a");
    expect(isPlaceDue(ok(NOW - DETAIL_OK_TTL_MS - j), OUT, NOW, "a")).toBe(true);
    expect(isPlaceDue(ok(NOW - DETAIL_OK_TTL_MS - j + 1), OUT, NOW, "a")).toBe(false);
  });

  it("R63: 여러 거점이 덮는 격자는 가장 늦은 시작이 기준이고(겹치면 더 자주 갱신), 대상이 된 시각은 가져온 뒤 처음 온 시작", () => {
    const mon: Hub = { ...BONG, id: "mon", refreshDay: 1 };
    const wed: Hub = { ...BONG, id: "wed", refreshDay: 3 };
    expect(tileRefreshStarts(KB, NOW, [wed, mon])).toEqual([S_BONG, S_WED]);
    expect(tileRefreshStart(KB, NOW, [mon, wed])).toBe(S_WED);
    expect(tileRefreshStart(KB, NOW, [mon])).toBe(S_BONG);
    // 월요일 전에 가져왔으면 월요일부터, 월~수 사이에 가져왔으면 수요일부터 대상
    const both = tileRefreshStarts(KB, NOW, [mon, wed]);
    expect(dueSinceOf(ok(S_BONG - 1), both, 0)).toBe(S_BONG);
    expect(dueSinceOf(ok(S_BONG + 1), both, 0)).toBe(S_WED);
    expect(dueSinceOf(ok(S_BONG - 1), tileRefreshStarts(KB, NOW), 0)).toBe(S_BONG);
    expect(dueSinceOf(failed(NOW - 7 * HOUR), tileRefreshStarts(KB, NOW), 0)).toBe(NOW - 7 * HOUR + DETAIL_FAIL_TTL_MS);
    // 거점 밖 칸(시작 없음): 3일 + 지터
    expect(dueSinceOf(ok(NOW - 4 * DAY), [], 1000)).toBe(NOW - 4 * DAY + DETAIL_OK_TTL_MS + 1000);
  });

  it("R63/R3: 거점 격자는 그 거점 갱신 시작 전에 수집했으면 다시 수집하고(7일 TTL 대신), 밖은 7일 — SQL(dueTileKeys)과 isTileDue가 같다", async () => {
    const missing = tileKeyOf(hubById("pangyo"));
    await markTile(env.DB, KB, S_BONG - 1, 0, false); // 시작 전 → 대상
    await markTile(env.DB, KD, S_DDP, 0, false); // 시작 정각 → 아님
    await markTile(env.DB, OUT, NOW - TILE_TTL_MS + 1, 0, false); // 밖, 7일 안 → 아님
    await markTile(env.DB, OUT2, NOW - TILE_TTL_MS, 0, false); // 밖, 7일 → 대상
    const keys = [KB, KD, OUT, OUT2, missing];
    const tiles = await getTiles(env.DB, keys);
    const byJs = keys.filter((k) => isTileDue(k, tiles.get(k), NOW));
    expect(byJs).toEqual([KB, OUT2, missing]);
    expect(await dueTileKeys(env.DB, keys, NOW)).toEqual(byJs);
    expect(tileFreshFrom(KB, NOW)).toBe(S_BONG);
    expect(tileFreshFrom(OUT, NOW)).toBe(NOW - TILE_TTL_MS + 1);
    // 시작 뒤에 수집한 격자는 7일이 다 되기 전이라도 다음 갱신 요일 00:00에 다시 대상
    await markTile(env.DB, KB, S_BONG + 2 * DAY, 0, false);
    expect(await dueTileKeys(env.DB, [KB], S_BONG + 7 * DAY - 1)).toEqual([]);
    expect(await dueTileKeys(env.DB, [KB], S_BONG + 7 * DAY)).toEqual([KB]);
  });
});

describe("R63 Cron 만료 후보 (거점마다 다른 기준)", () => {
  /** 만료 후보를 한 번 고르고 읽은 행 수를 같이 돌려준다 */
  const scan = async (keys: string[], now = NOW) => {
    const { db, log } = recordingDb(env.DB);
    const ids = (await expiredDetailStates(db, keys, now)).map((t) => t.id);
    return { ids, read: log.reduce((n, x) => n + x.read, 0) };
  };

  it("R63: 만료 후보는 거점마다 자기 갱신 시작 전에 가져온 ok와 6시간 지난 실패 — 두 시작 사이에 가져온 가게는 시작이 늦은 거점 것만", async () => {
    const mid = S_BONG + 12 * HOUR;
    await seedOk([["b-old", S_BONG - 1], ["b-mid", mid], ["d-old", S_DDP - 3 * DAY], ["d-mid", mid], ["d-new", S_DDP + 1]]);
    await replaceTilePlaces(env.DB, KB, ["b-old", "b-mid"], NOW, false);
    await replaceTilePlaces(env.DB, KD, ["d-old", "d-mid", "d-new", "d-fail", "d-failnew"], NOW, false);
    await saveDetailFailure(env.DB, "d-fail", "http_500", NOW - DETAIL_FAIL_TTL_MS);
    await saveDetailFailure(env.DB, "d-failnew", "http_500", NOW - HOUR);
    expect((await scan([KB, KD])).ids.sort()).toEqual(["b-old", "d-fail", "d-mid", "d-old"]);
    // 주어진 격자만
    expect((await scan([KB])).ids.sort()).toEqual(["b-old"]);
  });

  it("R63/R38: 시작 뒤에 가져온 거점 행은 커서가 지나가 다시 읽지 않고, 거점의 시작이 바뀌면(다음 갱신 요일) 처음부터 다시 읽어 새 대상을 찾는다", async () => {
    // 봉은사 행 200개(한 쪽보다 많고 3쪽보다 적다 — Task 58: 쪽 100행, 예전 300행일 때 400개)는 월요일 시작 뒤에 가져왔다(대상 아님).
    // 동대문 행 2개는 그 뒤, 화요일 시작 전(대상)
    const bong = Array.from({ length: 2 * EXPIRED_SCAN_LIMIT }, (_, i) => [`b${String(i).padStart(3, "0")}`, S_BONG + 1 + i] as [string, number]);
    await seedOk([...bong, ["d1", S_BONG + 1000], ["d2", S_BONG + 1001]]);
    await replaceTilePlaces(env.DB, KB, bong.map(([id]) => id), NOW, false);
    await replaceTilePlaces(env.DB, KD, ["d1", "d2"], NOW, false);
    expect((await scan([KB, KD])).ids).toEqual(["d1", "d2"]);
    const steady = await scan([KB, KD]);
    expect(steady.ids).toEqual(["d1", "d2"]);
    expect(steady.read).toBeLessThan(30);
    // 다음 월요일: 봉은사 시작이 바뀌어 커서를 버리고, 봉은사 행이 (오래된 순으로) 대상이 된다
    const nextMon = S_BONG + 7 * DAY + HOUR;
    const next = await scan([KB, KD], nextMon);
    expect(next.ids.slice(0, 3)).toEqual(["b000", "b001", "b002"]);
  });
});

describe("R63 만료 커서 — 대상이 드문 쪽", () => {
  it("R63/R38: 재설정이 아닌 실행도 읽은 쪽에 대상이 없으면 같은 실행에서 3쪽까지 이어 읽는다 — 갱신 창이 겹쳐 대상 아닌 행이 끼어 있어도 실행마다 나아간다", async () => {
    // 동대문 d1(대상) → 봉은사 시작 뒤에 가져온 250행(대상 아님 — 두 쪽보다 많고 세 쪽보다 적다. Task 58: 쪽 100행, 예전 300행일 때 700행) → 동대문 d2(대상)
    expect(EXPIRED_RESET_PAGES).toBe(3);
    const bong = Array.from({ length: 2.5 * EXPIRED_SCAN_LIMIT }, (_, i) => [`b${String(i).padStart(3, "0")}`, S_BONG + 1 + i] as [string, number]);
    await seedOk([["d1", S_BONG], ...bong, ["d2", S_BONG + 1000]]);
    await replaceTilePlaces(env.DB, KB, bong.map(([id]) => id), NOW, false);
    await replaceTilePlaces(env.DB, KD, ["d1", "d2"], NOW, false);
    const ids = async () => (await expiredDetailStates(env.DB, [KB, KD], NOW)).map((t) => t.id);
    expect(await ids()).toEqual(["d1"]); // 재설정: 첫 쪽에서 d1
    await env.DB.prepare("UPDATE places SET fetched_at = ? WHERE id = 'd1'").bind(NOW).run(); // 갱신됨
    expect(await ids()).toEqual(["d2"]); // 다음 실행이 같은 실행 안에서 250행(3쪽째)을 지나 d2를 찾는다
  });
});

describe("R63 Cron 순서", () => {
  it("R63: Cron은 미수집을 먼저, 그다음 갱신 시작이 오래된 거점부터, 같은 거점 안에서는 가까운 순(같으면 id순)으로 고른다", () => {
    const [bongFar] = farthest(BONG);
    const [ddpFar] = farthest(DDP);
    const states: TilePlaceState[] = [
      { id: "d-near", tileKey: KD, meta: ok(S_DDP - 1) },
      { id: "b-far", tileKey: bongFar, meta: ok(S_BONG - 1) },
      { id: "b-near2", tileKey: KB, meta: ok(S_BONG - 5 * DAY) },
      { id: "b-near1", tileKey: KB, meta: ok(S_BONG - 1) },
      { id: "new", tileKey: ddpFar, meta: null },
      { id: "fresh", tileKey: KB, meta: ok(S_BONG + 1) },
    ];
    expect(pickCronIds(states, HUBS, NOW, 10)).toEqual(["new", "b-near1", "b-near2", "b-far", "d-near"]);
    expect(pickCronIds(states, HUBS, NOW, 2)).toEqual(["new", "b-near1"]);
  });

  it("R63: Cron 순서는 넘겨받은 거점들의 요일로 정한다 (전역 HUBS를 보지 않는다)", () => {
    const states: TilePlaceState[] = [
      { id: "b", tileKey: KB, meta: ok(S_BONG - 1) },
      { id: "d", tileKey: KD, meta: ok(S_BONG - 1) },
    ];
    expect(pickCronIds(states, [BONG, DDP], NOW, 10)).toEqual(["b", "d"]); // 월 시작이 화 시작보다 오래됐다
    // 봉은사를 수요일 거점으로 넘기면 동대문(화)이 먼저
    expect(pickCronIds(states, [{ ...BONG, refreshDay: 3 }, DDP], NOW, 10)).toEqual(["d", "b"]);
    // 봉은사를 목요일(10/1 시작) 거점으로 넘기면 b는 그 시작 뒤에 가져온 것이라 대상이 아니다
    expect(pickCronIds(states, [{ ...BONG, refreshDay: 4 }, DDP], NOW, 10)).toEqual(["d"]);
  });

  it("R63/R9: 갱신이 밀려 있어도 실패 재시도 자리를 실행마다 하나 둔다 (배치 2 이상, 대상인 실패가 있을 때만) — 마지막 후보 대신 맨 앞에 둔다 (글자 예산·D1 호출로 배치 뒤쪽이 남겨져도 재시도는 한다)", () => {
    const backlog: TilePlaceState[] = ["b1", "b2", "b3", "b4", "b5"].map((id) => ({ id, tileKey: KB, meta: ok(S_BONG - 1) }));
    const fail: TilePlaceState = { id: "f1", tileKey: KB, meta: failed(NOW - 7 * HOUR) };
    const notYet: TilePlaceState = { id: "f2", tileKey: KB, meta: failed(NOW - HOUR) };
    expect(pickCronIds([...backlog, fail, notYet], HUBS, NOW, 4)).toEqual(["f1", "b1", "b2", "b3"]);
    expect(pickCronIds([...backlog, fail], HUBS, NOW, 1)).toEqual(["b1"]);
    expect(pickCronIds([...backlog, notYet], HUBS, NOW, 4)).toEqual(["b1", "b2", "b3", "b4"]);
    // 이미 자리 안에 있으면 그대로
    expect(pickCronIds([backlog[0], fail], HUBS, NOW, 4)).toEqual(["b1", "f1"]);
  });
});

describe("R63 거점 갱신 완료 기록", () => {
  it("R63: 갱신할 가게(미수집, 시작 전에 가져온 ok)가 하나라도 있으면 true — 실패와 시작 뒤에 가져온 것은 보지 않는다", async () => {
    const keys = tilesCoveringCircle(BONG, PREWARM_RADIUS);
    await seedOk([["fresh", S_BONG + 1]]);
    await saveDetailFailure(env.DB, "fail", "http_500", S_BONG - DAY);
    await replaceTilePlaces(env.DB, KB, ["fresh", "fail"], NOW, false);
    expect(await hubHasDue(env.DB, BONG, NOW)).toBe(false);
    await replaceTilePlaces(env.DB, keys[0], ["new"], NOW, false);
    expect(await hubHasDue(env.DB, BONG, NOW)).toBe(true);
    await replaceTilePlaces(env.DB, keys[0], [], NOW, false);
    await seedOk([["old", S_BONG - 1]]);
    await replaceTilePlaces(env.DB, keys[1], ["old"], NOW, false);
    expect(await hubHasDue(env.DB, BONG, NOW)).toBe(true);
  });

  it("R63/R38: 완료 확인 질의는 칸마다 tile_places 기본 키로, 가게는 places 기본 키로 찾는다 (표 전체 스캔 없음)", async () => {
    const r = await env.DB.prepare(`EXPLAIN QUERY PLAN ${HUB_DUE_EXISTS_SQL}`).bind('["1:1"]', NOW).all<{ detail: string }>();
    const plan = r.results.map((x) => x.detail).join("\n");
    expect(plan).toMatch(/SEARCH tp USING (COVERING )?INDEX sqlite_autoindex_tile_places_1 \(tile_key=\?\)/);
    expect(plan).toMatch(/SEARCH p USING INDEX sqlite_autoindex_places_1 \(id=\?\)/);
    expect(plan).not.toMatch(/SCAN (tp|p)\b/);
  });

  it("R63/R38: 완료 확인은 먼 칸부터 본다 — 갱신은 가까운 칸부터 하므로 남은 대상이 있으면 몇 행만 읽고 멈춘다", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => [`f${i}`, S_BONG + 1] as [string, number]);
    await seedOk([...rows, ["far-old", S_BONG - 1]]);
    await replaceTilePlaces(env.DB, KB, rows.map(([id]) => id), NOW, false);
    await replaceTilePlaces(env.DB, farthest(BONG)[0], ["far-old"], NOW, false);
    const { db, log } = recordingDb(env.DB);
    expect(await hubHasDue(db, BONG, NOW)).toBe(true);
    const q = log.filter((x) => x.sql === HUB_DUE_EXISTS_SQL);
    expect(q).toHaveLength(1);
    expect(q[0].read).toBeLessThan(20);
  });

  it("R63: 거점 격자가 다 수집됐고 갱신할 가게가 없으면 Cron이 meta hub_refreshed:{거점} = {start, at}을 남기고 스냅샷 표시를 올린다 — 같은 시작에는 다시 확인하지 않고, 다음 갱신 요일에 새로 한다", async () => {
    await markFresh(ALL_KEYS, NOW - HOUR);
    await seedOk([["b1", S_BONG - 1], ["b2", S_BONG + 1]]);
    await replaceTilePlaces(env.DB, KB, ["b1", "b2", "bf"], NOW - HOUR, false);
    await saveDetailFailure(env.DB, "bf", "http_500", NOW - HOUR);
    const place = fakePlaceApi({
      b1: [placeJson({ name: "b1", lat: BONG.lat, lng: BONG.lng }), placeJson({ name: "b1", lat: BONG.lat, lng: BONG.lng })],
      b2: placeJson({ name: "b2", lat: BONG.lat, lng: BONG.lng }),
    });
    // 다음 주 격자 재수집에도 같은 가게가 나온다
    const local = fakeKakaoLocal(["b1", "b2", "bf"].map((id) => doc(id, BONG.lat, BONG.lng)));
    const fetcher = routeFetch(local.fetcher, place.fetcher);
    const run = (now: number, db = env.DB) => runScheduled({ ...env, DB: db }, { fetcher, now, sleep: async () => {}, hubs: [BONG] });

    // 1: b1(시작 전)을 갱신한다. 이번 후보에 봉은사 격자가 있었으니 완료는 다음 실행이 본다
    const r1 = await run(NOW);
    expect(place.calls.map((c) => c.id)).toEqual(["b1"]);
    expect(r1.refreshed).toBeUndefined();
    expect(await readHubRefreshed(env.DB, "bongeunsa")).toBeNull();

    // 2: 남은 대상이 없다 (실패 bf는 막지 않는다) → 기록 + 스냅샷 표시
    const before = await stamp("bongeunsa");
    const t2 = NOW + 5 * 60_000;
    const r2 = await run(t2);
    expect(r2.refreshed).toBe("bongeunsa");
    expect(await refreshedMeta("bongeunsa")).toEqual({ start: S_BONG, at: t2 });
    expect(await readHubRefreshed(env.DB, "bongeunsa")).toEqual({ start: S_BONG, at: t2 });
    expect(await stamp("bongeunsa")).toBeGreaterThan(before);

    // 3: 같은 시작에는 확인 질의를 하지 않는다
    const { db, log } = recordingDb(env.DB);
    const r3 = await run(t2 + 5 * 60_000, db);
    expect(r3.refreshed).toBeUndefined();
    expect(log.some((x) => x.sql === HUB_DUE_EXISTS_SQL)).toBe(false);

    // 다음 월요일: 격자도 상세도 다시 대상 — 격자를 다 모으고 b1·b2를 갱신한 뒤에야 새 시작으로 기록한다
    const mon = S_BONG + 7 * DAY;
    let t = mon + 60_000;
    for (let i = 0; i < 40 && (await readHubRefreshed(env.DB, "bongeunsa"))?.start !== mon; i++, t += 5 * 60_000) await run(t);
    const done = await readHubRefreshed(env.DB, "bongeunsa");
    expect(done?.start).toBe(mon);
    expect(await dueTileKeys(env.DB, tilesCoveringCircle(BONG, PREWARM_RADIUS), t)).toEqual([]);
    expect(place.calls.map((c) => c.id).slice(1).filter((id) => id !== "bf").sort()).toEqual(["b1", "b2"]);
  });

  it("R63/R9: 남은 후보가 갱신 대상인 실패 행뿐이면 그 실행에서 완료로 기록한다 (실패는 완료를 막지 않는다 — 확인 질의와 같은 기준)", async () => {
    await markFresh(ALL_KEYS, NOW - HOUR);
    await seedOk([["b2", S_BONG + 1]]);
    await replaceTilePlaces(env.DB, KB, ["b2", "bf"], NOW - HOUR, false);
    await saveDetailFailure(env.DB, "bf", "http_500", NOW - 7 * HOUR); // 6시간 지나 다시 할 실패
    const place = fakePlaceApi({ bf: 404 });
    const r = await runScheduled(env, { fetcher: place.fetcher, now: NOW, sleep: async () => {}, hubs: [BONG] });
    expect(place.calls.map((c) => c.id)).toEqual(["bf"]);
    expect(r.refreshed).toBe("bongeunsa");
    expect(await readHubRefreshed(env.DB, "bongeunsa")).toEqual({ start: S_BONG, at: NOW });
  });

  it("R63: 거점 격자에 아직 수집할 격자가 남았으면 가게가 없어도 완료로 기록하지 않는다", async () => {
    await markFresh(ALL_KEYS, S_BONG - 1);
    const r = await runScheduled(env, {
      fetcher: routeFetch(fakeKakaoLocal([]).fetcher, fakePlaceApi({}).fetcher), now: NOW, sleep: async () => {}, hubs: [BONG],
    });
    expect(r.tiles.incomplete).toBeGreaterThan(0);
    expect(r.refreshed).toBeUndefined();
    expect(await readHubRefreshed(env.DB, "bongeunsa")).toBeNull();
  });
});

describe("R63 완료 확인 차례", () => {
  it("R63: 열린 거점(아직 이번 시작으로 기록 안 함) 집합이 그대로면 연속 m번(5분 간격) 실행 안에 모두 한 번씩 확인한다 — 실행마다 돌아가는 거점 순서와 상관없이", () => {
    const T0 = kst(2026, 10, 7, 10);
    for (const openIdx of [[0, 1, 2, 5], [0, 3, 4, 5], [1, 7], [2, 3, 6], [0, 1, 2, 3, 4, 5, 6, 7], [4]]) {
      const open = new Set(openIdx.map((i) => HUBS[i].id));
      for (let offset = 0; offset < HUBS.length; offset++) {
        const seen = new Set<string>();
        for (let i = 0; i < open.size; i++) {
          const now = T0 + (offset + i) * CRON_INTERVAL_MS;
          // 닫힌 거점은 이번 시작으로 이미 기록했다
          const refreshed = new Map(HUBS.filter((h) => !open.has(h.id)).map((h) => [h.id, { start: refreshStartOf(h, now) }]));
          const pick = pickRefreshCheck(hubOrder(HUBS, now), now, refreshed, { pendingTiles: new Set(), candidateTiles: new Set() });
          expect(pick && open.has(pick.hub.id), `${openIdx} @${offset + i}`).toBe(true);
          seen.add(pick!.hub.id);
        }
        expect([...seen].sort(), `${openIdx} from ${offset}`).toEqual([...open].sort());
      }
    }
  });
});

describe("Task 34 리뷰 잔여", () => {
  it("R11/R38: 유효 배치가 0이면(DETAIL_BATCH_SIZE 0) 만료 후보를 읽지 않는다 — 커서도 쓰지 않는다", async () => {
    await markFresh(ALL_KEYS, NOW);
    await seedOk([["b1", S_BONG - 1]]);
    await replaceTilePlaces(env.DB, KB, ["b1"], NOW, false);
    const { db, log } = recordingDb(env.DB);
    const zero = { ...env, DB: db, DETAIL_BATCH_SIZE: "0" } as unknown as Env;
    const r = await runScheduled(zero, { fetcher: fakePlaceApi({}).fetcher, now: NOW, sleep: async () => {} });
    expect(r.batch).toBe(0);
    expect(log.some((x) => /idx_places_status_(fetched_at|due)/.test(x.sql))).toBe(false); // R66: ok는 due_after 인덱스
    expect(await env.DB.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'expired_from:%'").first<{ n: number }>()).toEqual({ n: 0 });
  });
});
