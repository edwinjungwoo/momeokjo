import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WEEK_MS, detailFingerprint } from "../../shared/adaptiveRefresh";
import { ASEM, DETAIL_OK_TTL_MS } from "../../shared/constants";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { HUBS, hubById } from "../../shared/hubs";
import { hubStatuses } from "../../worker/dashboard";
import { hubHasDue } from "../../worker/hubRefresh";
import { dueSinceOf, tileRefreshStarts } from "../../worker/refreshSchedule";
import {
  EXPIRED_DUE_SCAN_SQL, detailJitterMs, expiredDetailStates, idsNeedingDetail, isPlaceDue, pickCronIds, pickDetailIds,
  replaceTilePlaces, saveDetail, saveDetailFailure, saveDetails, tilePlaceStates, type DetailMeta, type TilePlaceState,
} from "../../worker/repo";
import { makeSummary, sampleDetail } from "../helpers/places";
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
