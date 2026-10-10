import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SHOW_REFRESH_AFTER_MS, WEEK_MS, detailFingerprint } from "../../shared/adaptiveRefresh";
import { ASEM, DETAIL_OK_TTL_MS } from "../../shared/constants";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { HUBS, hubById } from "../../shared/hubs";
import { utcDay } from "../../shared/kst";
import { createApp } from "../../worker/app";
import { d1UsageOn, recordCronRun, recordD1Usage } from "../../worker/d1Usage";
import { runScheduled } from "../../worker/maintenance";
import { parseDetail } from "../../worker/detailParser";
import { SNAPSHOT_DIRTY_PREFIX } from "../../worker/snapshotDirty";
import { hubStatuses } from "../../worker/dashboard";
import { hubHasDue } from "../../worker/hubRefresh";
import { dueSinceOf, tileRefreshStarts } from "../../worker/refreshSchedule";
import {
  EXPIRED_DUE_SCAN_SQL, detailJitterMs, expiredDetailStates, idsNeedingDetail, isPlaceDue, pickCronIds, pickDetailIds,
  placeById, recordPlaceBlock, replaceTilePlaces, saveDetail, saveDetailFailure, saveDetails, tilePlaceStates, type DetailMeta, type TilePlaceState,
} from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { fakePlaceApi } from "../helpers/fakeKakao";
import { makeSummary, placeJson, sampleDetail } from "../helpers/places";
import { recordingDb } from "../helpers/recordDb";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;
const S = makeSummary(ASEM.lat, ASEM.lng, { name: "가게" });

/** 저장된 R66 열 */
async function adaptive(id: string) {
  return env.DB.prepare("SELECT interval_weeks AS w, fp, due_after AS dueAfter, fetched_at AS fetchedAt, status FROM places WHERE id = ?")
    .bind(id)
    .first<{ w: number; fp: string | null; dueAfter: number | null; fetchedAt: number; status: string }>();
}

describe("R66 0008 마이그레이션", () => {
  it("R66: places에 interval_weeks(기본 1)·fp·due_after 열과 (status, due_after) 인덱스가 있다", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(places)").all<{ name: string; dflt_value: string | null; notnull: number }>()).results;
    const w = cols.find((c) => c.name === "interval_weeks");
    expect(w).toMatchObject({ notnull: 1, dflt_value: "1" });
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["fp", "due_after"]));
    const idx = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_places_status_due'").first<{ sql: string }>();
    expect(idx?.sql).toMatch(/places\s*\(\s*status\s*,\s*due_after\s*\)/);
  });
});

describe("R66 상세 저장 — 지문과 주기", () => {
  it("R66: 처음 저장은 주기 1, 지문이 같으면 2 → 4 → 4, 다르면 1 — due_after = 가져온 시각 + (주기 − 1) × 7일", async () => {
    const d = sampleDetail();
    const fp = detailFingerprint(S, d);
    await saveDetail(env.DB, "1", S, d, NOW);
    expect(await adaptive("1")).toMatchObject({ w: 1, fp, dueAfter: NOW, fetchedAt: NOW });
    await saveDetail(env.DB, "1", S, d, NOW + 7 * DAY);
    expect(await adaptive("1")).toMatchObject({ w: 2, fp, dueAfter: NOW + 7 * DAY + WEEK_MS });
    await saveDetail(env.DB, "1", S, sampleDetail({ reviewCount: 999 }), NOW + 14 * DAY); // 리뷰 수만 바뀜 = 같음
    expect(await adaptive("1")).toMatchObject({ w: 4, fp, dueAfter: NOW + 14 * DAY + 3 * WEEK_MS });
    await saveDetail(env.DB, "1", S, d, NOW + 35 * DAY);
    expect(await adaptive("1")).toMatchObject({ w: 4, dueAfter: NOW + 35 * DAY + 3 * WEEK_MS });
    const changed = sampleDetail({ price: 15000 });
    await saveDetail(env.DB, "1", S, changed, NOW + 63 * DAY);
    expect(await adaptive("1")).toMatchObject({ w: 1, fp: detailFingerprint(S, changed), dueAfter: NOW + 63 * DAY });
  });

  it("R66/R9: 실패는 주기·지문·due_after를 바꾸지 않는다 — 다음 성공은 실패 전 지문과 비교한다", async () => {
    const d = sampleDetail();
    await saveDetail(env.DB, "1", S, d, NOW);
    await saveDetail(env.DB, "1", S, d, NOW + 7 * DAY); // 2주
    const before = await adaptive("1");
    await saveDetailFailure(env.DB, "1", "http_500", NOW + 21 * DAY);
    expect(await adaptive("1")).toMatchObject({ status: "failed", w: before!.w, fp: before!.fp, dueAfter: before!.dueAfter, fetchedAt: NOW + 21 * DAY });
    await saveDetail(env.DB, "1", S, d, NOW + 22 * DAY);
    expect(await adaptive("1")).toMatchObject({ status: "ok", w: 4, dueAfter: NOW + 22 * DAY + 3 * WEEK_MS });
  });

  it("R66: 마이그레이션 전 행(지문 없음)과 한 번도 성공하지 못한 행은 처음처럼 주기 1에서 시작한다", async () => {
    await env.DB.prepare(
      "INSERT INTO places (id, status, name, lat, lng, fetched_at, interval_weeks) VALUES ('old', 'ok', '예전', 37.5, 127.0, ?, 4)",
    ).bind(NOW - 30 * DAY).run();
    await saveDetailFailure(env.DB, "never", "http_500", NOW - DAY);
    await saveDetail(env.DB, "old", S, sampleDetail(), NOW);
    await saveDetail(env.DB, "never", S, sampleDetail(), NOW);
    expect(await adaptive("old")).toMatchObject({ w: 1, dueAfter: NOW });
    expect(await adaptive("never")).toMatchObject({ w: 1, dueAfter: NOW });
  });

  it("R66: 열어 본 가게의 저장(weekly)은 지문이 같아도 주기 1로 둔다 — 묶음 저장(saveDetails)도 같은 문장", async () => {
    const d = sampleDetail();
    await saveDetail(env.DB, "1", S, d, NOW);
    await saveDetail(env.DB, "1", S, d, NOW + 7 * DAY);
    expect((await adaptive("1"))?.w).toBe(2);
    await saveDetail(env.DB, "1", S, d, NOW + 14 * DAY, { weekly: true });
    expect(await adaptive("1")).toMatchObject({ w: 1, dueAfter: NOW + 14 * DAY });
    await saveDetails(env.DB, [{ id: "1", summary: S, detail: d }, { id: "2", summary: S, detail: d }], NOW + 21 * DAY);
    expect(await adaptive("1")).toMatchObject({ w: 2, dueAfter: NOW + 21 * DAY + WEEK_MS });
    expect(await adaptive("2")).toMatchObject({ w: 1, dueAfter: NOW + 21 * DAY });
  });
});

// ── R66 대상 판단: fetched_at 대신 due_after ─────────────────────────────

const HOUR = 3600_000;
/** KST 시각 → epoch ms */
const kst = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
/** 2026-10-07 수요일 10:00 KST */
const T = kst(2026, 10, 7, 10);
const BONG = hubById("bongeunsa"); // 월
const S_BONG = kst(2026, 10, 5);
const KB = tileKeyOf(BONG);
const NEXT_MON = S_BONG + 7 * DAY;

const ok = (fetchedAt: number, dueAfter?: number | null): NonNullable<DetailMeta> => ({ status: "ok", fetchedAt, reason: null, dueAfter });

/** [id, fetched_at, due_after(null이면 NULL — 배포 전 옛 코드가 쓴 행), interval] 를 ok로 (좌표는 봉은사) */
async function seedDue(rows: [string, number, number | null, number?][]) {
  await env.DB.prepare(
    `INSERT INTO places (id, status, name, category_name, category_group, lat, lng, fetched_at, due_after, interval_weeks)
     SELECT json_extract(value, '$[0]'), 'ok', '가게', '음식점 > 한식', 'korean', ?, ?, json_extract(value, '$[1]'),
       json_extract(value, '$[2]'), COALESCE(json_extract(value, '$[3]'), 1) FROM json_each(?)`,
  ).bind(BONG.lat, BONG.lng, JSON.stringify(rows)).run();
}

describe("R66 갱신 대상 — due_after가 거점 갱신 시작보다 이를 때", () => {
  it("R66/R63: 거점 격자의 ok는 due_after < 갱신 시작일 때 대상 — 주기 2주인 가게는 한 주 건너뛰고, due_after가 NULL이면 fetched_at으로 본다", () => {
    expect(isPlaceDue(ok(S_BONG - 1, S_BONG - 1), KB, T, "a")).toBe(true);
    // 지난주 화요일에 가져와 주기 2주 → due_after는 이번 주 화요일: 이번 월요일 시작에는 대상이 아니고 다음 월요일부터 대상
    const lastTue = S_BONG - 6 * DAY;
    expect(isPlaceDue(ok(lastTue, lastTue + WEEK_MS), KB, T, "a")).toBe(false);
    expect(isPlaceDue(ok(lastTue, lastTue + WEEK_MS), KB, NEXT_MON, "a")).toBe(true);
    // 주기 4주: 3주 동안 건너뛴다
    expect(isPlaceDue(ok(lastTue, lastTue + 3 * WEEK_MS), KB, NEXT_MON + 14 * DAY - 1, "a")).toBe(false);
    expect(isPlaceDue(ok(lastTue, lastTue + 3 * WEEK_MS), KB, NEXT_MON + 14 * DAY, "a")).toBe(true);
    // NULL·없음은 fetched_at (절대 "지금 대상"으로 치지 않는다)
    expect(isPlaceDue(ok(S_BONG + 1, null), KB, T, "a")).toBe(false);
    expect(isPlaceDue(ok(S_BONG + 1), KB, T, "a")).toBe(false);
    expect(isPlaceDue(ok(S_BONG - 1, null), KB, T, "a")).toBe(true);
    // 거점 밖 격자는 예전 3일 + 지터 그대로 (due_after를 보지 않는다)
    const j = detailJitterMs("a");
    expect(isPlaceDue(ok(T - DETAIL_OK_TTL_MS - j, T + 3 * WEEK_MS), "1:1", T, "a")).toBe(true);
  });

  it("R66/R63: Cron 순서도 due_after로 — 아직 대상이 아닌 긴 주기 가게는 고르지 않고, 대상이 된 시각은 due_after 뒤 처음 온 시작", () => {
    const lastTue = S_BONG - 6 * DAY;
    const states: TilePlaceState[] = [
      { id: "long", tileKey: KB, meta: ok(S_BONG - 20 * DAY, lastTue + WEEK_MS) },
      { id: "weekly", tileKey: KB, meta: ok(S_BONG - 1, S_BONG - 1) },
      { id: "legacy", tileKey: KB, meta: ok(S_BONG - 2, null) },
    ];
    expect(pickCronIds(states, HUBS, T, 10)).toEqual(["legacy", "weekly"]);
    // 다음 월요일: 셋 다 그 시작부터 대상 (같은 시각·같은 칸이면 id순)
    expect(pickCronIds(states, HUBS, NEXT_MON + HOUR, 10)).toEqual(["legacy", "long", "weekly"]);
    expect(dueSinceOf(ok(S_BONG - 20 * DAY, lastTue + WEEK_MS), tileRefreshStarts(KB, NEXT_MON + HOUR), 0)).toBe(NEXT_MON);
  });

  it("R66/R11/R38: 만료 후보는 (status, due_after)로 — 긴 주기라 아직 아닌 행은 지나가고(커서가 넘어간다), NULL 행은 fetched_at으로 본다. 다음 갱신 요일에는 처음부터 다시 읽어 새 대상을 찾는다", async () => {
    const lastTue = S_BONG - 6 * DAY;
    // legacy(NULL, 시작 전) · two(주기 2, 이번 주 아님) 300곳 · due(주기 1, 시작 전) · fresh(NULL, 시작 뒤)
    const two = Array.from({ length: 300 }, (_, i) => [`t${String(i).padStart(3, "0")}`, lastTue + i, lastTue + i + WEEK_MS, 2] as [string, number, number, number]);
    await seedDue([["legacy", S_BONG - 5, null], ["fresh", S_BONG + 5, null], ...two, ["due", S_BONG - 3, S_BONG - 3]]);
    await replaceTilePlaces(env.DB, KB, ["legacy", "fresh", "due", ...two.map(([id]) => id)], T, false);
    const scan = async (now = T) => {
      const { db, log } = recordingDb(env.DB);
      const ids = (await expiredDetailStates(db, [KB], now)).map((t) => t.id);
      return { ids, read: log.reduce((n, x) => n + x.read, 0), scans: log.filter((x) => x.sql === EXPIRED_DUE_SCAN_SQL).length };
    };
    const first = await scan();
    expect(first.ids).toEqual(["legacy", "due"]);
    // 대상 행이 갱신되면(due_after가 앞으로) 다음 실행은 커서부터 — 지나간 행을 다시 읽지 않는다
    await env.DB.prepare("UPDATE places SET fetched_at = ?, due_after = ? WHERE id IN ('legacy', 'due')").bind(T, T).run();
    const steady = await scan();
    expect(steady.ids).toEqual([]);
    const again = await scan();
    expect(again.ids).toEqual([]);
    expect(again.read).toBeLessThan(30);
    // 다음 월요일: 시작이 바뀌어 처음부터 — NULL 구간(fresh, fetched_at이 다음 시작 전)부터, 그다음 주기 2주 행이 due_after 순으로
    const next = await scan(NEXT_MON + HOUR);
    expect(next.ids.slice(0, 4)).toEqual(["fresh", "t000", "t001", "t002"]);
  });

  it("R66/R11: 만료 후보 조회는 (status, due_after) 인덱스를 범위로 읽고(NULL 구간 포함) places 전체 스캔·정렬용 임시 B-트리를 쓰지 않는다", async () => {
    for (const from of [null, 0]) {
      const r = await env.DB.prepare(`EXPLAIN QUERY PLAN ${EXPIRED_DUE_SCAN_SQL}`).bind("ok", from, 0, T, 300).all<{ detail: string }>();
      const plan = r.results.map((x) => x.detail).join("\n");
      expect(plan).toMatch(/SEARCH p USING INDEX idx_places_status_due \(status=\? AND due_after=\? AND rowid>\?\)/);
      expect(plan).toMatch(/SEARCH p USING INDEX idx_places_status_due \(status=\? AND due_after>\? AND due_after<\?\)/);
      expect(plan).not.toMatch(/SCAN p\b/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
  });

  it("R66/R63: 거점 완료 확인은 due_after로 — 시작 전에 가져왔어도 긴 주기라 아직 대상이 아니면 완료를 막지 않는다 (NULL은 fetched_at)", async () => {
    const lastTue = S_BONG - 6 * DAY;
    await seedDue([["long", lastTue, lastTue + WEEK_MS, 2], ["fresh", S_BONG + 1, null]]);
    await replaceTilePlaces(env.DB, KB, ["long", "fresh"], T, false);
    expect(await hubHasDue(env.DB, BONG, T)).toBe(false);
    expect(await hubHasDue(env.DB, BONG, NEXT_MON + HOUR)).toBe(true);
    await seedDue([["legacy", S_BONG - 1, null]]);
    await replaceTilePlaces(env.DB, KB, ["long", "fresh", "legacy"], T, false);
    expect(await hubHasDue(env.DB, BONG, T)).toBe(true);
  });

  it("R66/R10: warm 후보(가까운 순 SQL)도 거점 칸은 due_after로 거른다 — 고른 결과는 격자 상태를 다 읽어 고른 것과 같다", async () => {
    const lastTue = S_BONG - 6 * DAY;
    const keys = tilesCoveringCircle(BONG, 1000);
    await seedDue([["long", lastTue, lastTue + WEEK_MS, 2], ["weekly", S_BONG - 1, S_BONG - 1], ["legacy", S_BONG - 2, null]]);
    await replaceTilePlaces(env.DB, KB, ["long", "weekly", "legacy", "new"], T, false);
    const want = pickDetailIds(await tilePlaceStates(env.DB, keys), BONG, T, 10, "due");
    expect([...want].sort()).toEqual(["legacy", "new", "weekly"]);
    expect(await idsNeedingDetail(env.DB, BONG, 1000, T, 10, "due")).toEqual(want);
  });
});

describe("R66 관리 화면 남은 갱신", () => {
  it("R66/R63: 거점 표의 남은 갱신은 due_after가 이번 시작 전인 ok만 센다 (긴 주기로 건너뛰는 가게는 빼고, NULL은 fetched_at)", async () => {
    const lastTue = S_BONG - 6 * DAY;
    await seedDue([["long", lastTue, lastTue + WEEK_MS, 2], ["weekly", S_BONG - 1, S_BONG - 1], ["legacy", S_BONG - 2, null], ["fresh", S_BONG + 1, null]]);
    await replaceTilePlaces(env.DB, KB, ["long", "weekly", "legacy", "fresh"], T, false);
    const bong = (await hubStatuses(env.DB, T)).find((h) => h.hub === "bongeunsa")!;
    expect(bong).toMatchObject({ ok: 4, due: 2 });
  });
});

// ── R66 계수 (관리 화면): 같음·바뀜·처음 ─────────────────────────────

const counters = async (day: string) => {
  const r = await env.DB.prepare("SELECT key, value FROM meta WHERE key LIKE 'detail_%'").all<{ key: string; value: string }>();
  const get = (k: string) => Number(r.results.find((x) => x.key === `${k}:${day}`)?.value ?? 0);
  return { same: get("detail_same"), changed: get("detail_changed"), first: get("detail_first") };
};
const ALL_KEYS = [...new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, 1000)))];
async function markFresh(keys: string[], at: number) {
  for (let i = 0; i < keys.length; i += 200) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO tiles (key, collected_at, place_count, saturated) SELECT value, ?, 0, 0 FROM json_each(?)",
    ).bind(at, JSON.stringify(keys.slice(i, i + 200))).run();
  }
}
const bongJson = (name: string) => placeJson({ name, lat: BONG.lat, lng: BONG.lng });

describe("R66 계수 — UTC 하루마다 detail_same·detail_changed·detail_first", () => {
  it("R66/R38: 사용량 기록 한 문장에 계수를 같이 더한다 (0인 계수는 쓰지 않는다) — 요청(recordD1Usage)·Cron(recordCronRun) 모두", async () => {
    const day = utcDay(T);
    const { db, log } = recordingDb(env.DB);
    await recordD1Usage(db, { read: 10, written: 2, details: { same: 3, changed: 1, first: 0 } }, T);
    await recordCronRun(db, { read: 5, written: 1, details: { same: 1, changed: 0, first: 2 } }, T, { at: T });
    expect(log).toHaveLength(2);
    expect(await counters(day)).toEqual({ same: 4, changed: 1, first: 2 });
    expect(await d1UsageOn(env.DB, day)).toEqual({ read: 15, written: 3 });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM meta WHERE key LIKE 'detail_changed:%' OR key LIKE 'detail_first:%'").first<{ n: number }>()).toEqual({ n: 2 });
  });

  it("R66: Cron은 처음 가져온 곳은 first, 다시 가져와 지문이 같으면 same, 다르면 changed로 센다 — 계수 쓰기는 끝의 사용량 기록 문장 하나뿐", async () => {
    await markFresh(ALL_KEYS, T);
    await replaceTilePlaces(env.DB, KB, ["a", "b"], T, false);
    const place = fakePlaceApi({ a: [bongJson("a"), bongJson("a")], b: [bongJson("b"), bongJson("b 새이름")] });
    const run = async (now: number) => {
      const { db, log } = recordingDb(env.DB);
      await runScheduled({ ...env, DB: db }, { fetcher: place.fetcher, now, sleep: async () => {}, hubs: [BONG] });
      return log.filter((x) => /detail_(same|changed|first)/.test(x.sql) || x.sql.includes("cron_last")).length;
    };
    expect(await run(T)).toBe(1);
    expect(await counters(utcDay(T))).toEqual({ same: 0, changed: 0, first: 2 });
    // 둘 다 다시 대상으로 (시작 전으로 되돌린다)
    await env.DB.prepare("UPDATE places SET due_after = ? WHERE id IN ('a', 'b')").bind(S_BONG - 1).run();
    expect(await run(T + 5 * 60_000)).toBe(1);
    expect(await counters(utcDay(T))).toEqual({ same: 1, changed: 1, first: 2 });
    expect(await adaptive("a")).toMatchObject({ w: 2 });
    expect(await adaptive("b")).toMatchObject({ w: 1 });
  });
});

describe("R66 계수 — 요청 경로", () => {
  it("R66/R38: 요청이 저장한 상세(단건 처음 가져오기·warm 보충)도 요청 끝의 사용량 기록 문장에 계수를 더한다", async () => {
    await replaceTilePlaces(env.DB, KB, ["601"], T, false);
    const place = fakePlaceApi({ "601": bongJson("가게601"), "602": bongJson("가게602"), "603": bongJson("가게603") });
    const app = createApp({ fetcher: place.fetcher, now: () => T, sleep: async () => {}, rateLimit: async () => true });
    expect((await callApp(app, "/api/places/601")).status).toBe(200);
    expect(await counters(utcDay(T))).toEqual({ same: 0, changed: 0, first: 1 });
    // warm: 격자는 방금 모았고(빈 격자), 기록된 가게 둘의 상세를 처음 가져온다
    await markFresh(tilesCoveringCircle(BONG, 300), T);
    await replaceTilePlaces(env.DB, KB, ["601", "602", "603"], T, false);
    const res = await callApp(app, `/api/admin/warm?lat=${BONG.lat}&lng=${BONG.lng}&radius=300`, {
      method: "POST", headers: { Authorization: "Bearer test-admin-token" },
    });
    expect(await res.json()).toMatchObject({ enriched: 2 });
    expect(await counters(utcDay(T))).toEqual({ same: 0, changed: 0, first: 3 });
  });
});

// ── R66 볼 때 신선하게 (GET /api/places/:id) ─────────────────────────────

describe("R66 볼 때 신선하게 — 단건 조회의 stale-while-revalidate", () => {
  const STALE = T - SHOW_REFRESH_AFTER_MS - 1;
  const seedShown = async (id: string, fetchedAt: number, name = "예전이름") => {
    await saveDetail(env.DB, id, makeSummary(BONG.lat, BONG.lng, { name }), sampleDetail(), fetchedAt);
    await replaceTilePlaces(env.DB, KB, [id], fetchedAt, false);
  };
  const appWith = (responses: Record<string, unknown>, opts: { allow?: boolean } = {}) => {
    const place = fakePlaceApi(responses);
    let limited = 0;
    const app = createApp({
      fetcher: place.fetcher, now: () => T, sleep: async () => {},
      rateLimit: async () => {
        limited += 1;
        return opts.allow ?? true;
      },
    });
    return { app, place, limited: () => limited };
  };
  const stamp = async () =>
    Number((await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT_DIRTY_PREFIX + "bongeunsa").first<{ value: string }>())?.value ?? 0);

  it("R66: 7일 넘게 지난 ok 가게를 열면 저장된 그대로 바로 답하고, 뒤에서 그 한 곳만 다시 가져와 저장한다 — 주기 1주·스냅샷 표시·계수", async () => {
    await seedShown("501", STALE);
    const before = await stamp();
    const { app, place } = appWith({ "501": bongJson("새이름") });
    const res = await callApp(app, "/api/places/501");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "501", name: "예전이름", fetchedAt: STALE });
    expect(place.calls.map((c) => c.id)).toEqual(["501"]);
    const row = (await placeById(env.DB, "501"))!;
    expect(row.place.name).toBe("새이름");
    expect(row.meta.fetchedAt).toBe(T);
    expect(await adaptive("501")).toMatchObject({ w: 1, dueAfter: T });
    expect(await stamp()).toBeGreaterThan(before);
    expect(await counters(utcDay(T))).toEqual({ same: 0, changed: 1, first: 0 });
    // 다시 열면 이제 신선하다 — 부르지 않는다
    await callApp(app, "/api/places/501");
    expect(place.calls).toHaveLength(1);
  });

  it("R66: 지문이 같아도 열어 본 가게는 주기 1주로 둔다 (긴 주기였어도) — 계수는 same", async () => {
    // 상세 응답을 그대로 두 번 저장해 주기 2주 (응답과 같은 지문)
    const parsed = parseDetail(bongJson("같은이름"));
    if (!parsed.ok) throw new Error("fixture");
    await saveDetail(env.DB, "502", parsed.summary, parsed.detail, STALE - 7 * DAY);
    await saveDetail(env.DB, "502", parsed.summary, parsed.detail, STALE);
    await replaceTilePlaces(env.DB, KB, ["502"], STALE, false);
    expect((await adaptive("502"))?.w).toBe(2);
    const { app, place } = appWith({ "502": bongJson("같은이름") });
    await callApp(app, "/api/places/502");
    expect(place.calls).toHaveLength(1);
    expect(await adaptive("502")).toMatchObject({ w: 1, dueAfter: T });
    expect(await counters(utcDay(T))).toEqual({ same: 1, changed: 0, first: 0 });
  });

  it("R66: 7일 안이면 다시 가져오지 않는다 (정확히 7일도)", async () => {
    await seedShown("503", T - SHOW_REFRESH_AFTER_MS);
    const { app, place, limited } = appWith({ "503": bongJson("새이름") });
    expect((await callApp(app, "/api/places/503")).status).toBe(200);
    expect(place.calls).toHaveLength(0);
    expect(limited()).toBe(0);
  });

  it("R66/R52/R10/R44/R15: 읽기 전용·쿨다운·frozen·요청 제한이면 다시 가져오지 않는다 (응답은 그대로)", async () => {
    await seedShown("504", STALE);
    const ro = appWith({ "504": bongJson("새이름") });
    expect((await callApp(ro.app, "/api/places/504", undefined, { ...env, READ_ONLY: "1" } as unknown as Env)).status).toBe(200);
    expect(ro.place.calls).toHaveLength(0);
    const limited = appWith({ "504": bongJson("새이름") }, { allow: false });
    expect((await callApp(limited.app, "/api/places/504")).status).toBe(200);
    expect(limited.place.calls).toHaveLength(0);
    expect(limited.limited()).toBe(1);
    await recordPlaceBlock(env.DB, T - 60_000); // 쿨다운
    const cool = appWith({ "504": bongJson("새이름") });
    expect((await callApp(cool.app, "/api/places/504")).status).toBe(200);
    expect(cool.place.calls).toHaveLength(0);
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('place_blocked_until', '0'), ('detail_mode', ?)")
      .bind(JSON.stringify({ mode: "frozen", since: T - HOUR, until: T + HOUR })).run();
    const frozen = appWith({ "504": bongJson("새이름") });
    expect((await callApp(frozen.app, "/api/places/504")).status).toBe(200);
    expect(frozen.place.calls).toHaveLength(0);
    expect((await placeById(env.DB, "504"))?.place.name).toBe("예전이름");
  });

  it("R66/R9/R10: 다시 가져오기가 실패하면 Cron처럼 실패를 기록하고(표시 정보는 그대로), 403·429면 쿨다운을 건다", async () => {
    await seedShown("505", STALE);
    const { app } = appWith({ "505": 429 });
    expect((await callApp(app, "/api/places/505")).status).toBe(200);
    const row = (await placeById(env.DB, "505"))!;
    expect(row.meta).toMatchObject({ status: "failed", reason: "http_429", fetchedAt: T });
    expect(row.place.name).toBe("예전이름");
    expect(await adaptive("505")).toMatchObject({ w: 1, dueAfter: STALE });
    expect((await env.DB.prepare("SELECT value FROM meta WHERE key = 'place_blocked_until'").first<{ value: string }>())?.value).toBe(String(T + 30 * 60_000));
  });

  it("R66: 같은 isolate에서 같은 가게를 동시에 여러 번 열어도 다시 가져오기는 한 번 (상세 API 한 번)", async () => {
    await seedShown("506", STALE);
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const place = fakePlaceApi({ "506": bongJson("새이름") });
    const app = createApp({
      fetcher: async (input, init) => {
        await gate;
        return place.fetcher(input, init);
      },
      now: () => T, sleep: async () => {}, rateLimit: async () => true,
    });
    const ctxs = [createExecutionContext(), createExecutionContext()];
    const res = await Promise.all(ctxs.map((ctx) => app.fetch(new Request("http://localhost/api/places/506"), env, ctx)));
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    release();
    for (const ctx of ctxs) await waitOnExecutionContext(ctx);
    expect(place.calls).toHaveLength(1);
    // 끝나면 다시 열 수 있다 (이번에는 신선해서 부르지 않는다)
    await callApp(app, "/api/places/506");
    expect(place.calls).toHaveLength(1);
  });
});
