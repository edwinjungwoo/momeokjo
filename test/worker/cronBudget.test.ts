import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DETAIL_FAIL_TTL_MS, DETAIL_JITTER_MS, DETAIL_OK_TTL_MS, PREWARM_RADIUS } from "../../shared/constants";
import { tileKeyOf, tileRect, tilesCoveringCircle, haversine } from "../../shared/geo";
import { HUBS } from "../../shared/hubs";
import { kstDay } from "../../shared/kst";
import { createApp } from "../../worker/app";
import { CRON_D1_CALL_LIMIT, runScheduled } from "../../worker/maintenance";
import { replaceTilePlaces } from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { anonN, seedEvents, sessN } from "../helpers/events";
import { fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { placeJson } from "../helpers/places";

const DAY = 24 * 3600_000;
/** KST 2027-01-15 04:01 — R35 보관 정리 창 (본 Cron이 이벤트·집계 정리까지 하는 실행) */
const NOW = Date.UTC(2027, 0, 14, 19, 1);
const KEYS = [...new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)))];

/** D1 호출 수를 센다 — batch()는 한 번(왕복 하나), 문장마다 all/run/first/raw 한 번 */
class CountStatement {
  constructor(readonly inner: D1PreparedStatement, private readonly n: { calls: number }) {}
  bind(...v: unknown[]) {
    return new CountStatement(this.inner.bind(...v), this.n);
  }
  all<T>() {
    this.n.calls++;
    return this.inner.all<T>();
  }
  run<T>() {
    this.n.calls++;
    return this.inner.run<T>();
  }
  first<T>(col?: string) {
    this.n.calls++;
    return col === undefined ? this.inner.first<T>() : this.inner.first<T>(col);
  }
  raw<T>() {
    this.n.calls++;
    return this.inner.raw<T>();
  }
}
function countingDb(db: D1Database) {
  const n = { calls: 0 };
  const wrapped = {
    prepare: (q: string) => new CountStatement(db.prepare(q), n) as unknown as D1PreparedStatement,
    batch: (stmts: D1PreparedStatement[]) => {
      n.calls++;
      return db.batch(stmts.map((s) => (s as unknown as CountStatement).inner));
    },
    exec: (q: string) => {
      n.calls++;
      return db.exec(q);
    },
    withSession: (c?: string) => db.withSession(c),
    dump: () => db.dump(),
  };
  return { db: wrapped as unknown as D1Database, n };
}

const json = (rows: unknown[]) => JSON.stringify(rows);
async function insertPlaces(rows: [string, string, number][]) {
  for (let i = 0; i < rows.length; i += 200) {
    await env.DB.prepare(
      `INSERT INTO places (id, status, fetched_at) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]')
       FROM json_each(?)`,
    ).bind(json(rows.slice(i, i + 200))).run();
  }
}
async function markFresh(keys: string[], at: number) {
  for (let i = 0; i < keys.length; i += 200) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO tiles (key, collected_at, place_count, saturated) SELECT value, ?, 0, 0 FROM json_each(?)",
    ).bind(at, json(keys.slice(i, i + 200))).run();
  }
}
const midDist = (k: string) => {
  const r = tileRect(k);
  const mid = { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 };
  return Math.min(...HUBS.map((h) => haversine(h, mid)));
};

describe("Task 34: 본 Cron의 D1 호출 예산", () => {
  /**
   * 최악에 가까운 본 Cron: 보관 정리 창, 격자 dueCount칸 수집(칸마다 로컬 검색 1번 + D1 2번), 만료 커서 재설정(상태마다 3쪽),
   * 미수집은 가장 먼 칸(앞선 커서 없이 처음부터 걷는다), 저장이 모두 실패(묶음도 한 곳씩도), 오늘 세 번째 차단(강등 모드), 밀린 집계 3일
   */
  async function worstCase(dueCount: number) {
    const home = tileKeyOf(HUBS[0]);
    const far = [...KEYS].sort((a, b) => midDist(b) - midDist(a))[0];
    const due = KEYS.filter((k) => k !== home && k !== far).slice(0, dueCount);
    await markFresh(KEYS.filter((k) => !due.includes(k)), NOW);
    await insertPlaces([
      ...Array.from({ length: 850 }, (_, i) => [`ook${i}`, "ok", NOW - 10 * DETAIL_OK_TTL_MS + i] as [string, string, number]),
      ...Array.from({ length: 850 }, (_, i) => [`ofail${i}`, "failed", NOW - 10 * DETAIL_FAIL_TTL_MS + i] as [string, string, number]),
      ...["e1", "e2", "e3", "e4"].map((id) => [id, "ok", NOW - DETAIL_OK_TTL_MS - DETAIL_JITTER_MS - 1000] as [string, string, number]),
    ]);
    await replaceTilePlaces(env.DB, home, ["e1", "e2", "e3", "e4"], NOW, false);
    await replaceTilePlaces(env.DB, far, ["farnew"], NOW, false);
    await env.DB.prepare(
      "CREATE TRIGGER bad_rows BEFORE INSERT ON places WHEN NEW.id IN ('e1', 'e2', 'e3', 'e4', 'farnew') BEGIN SELECT RAISE(ABORT, 'bad row'); END",
    ).run();
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, '2')").bind(`block_count:${kstDay(NOW)}`).run();
    await seedEvents([1, 2, 3].map((d) => ({
      anon: anonN(d), session: sessN(d), ts: NOW - d * DAY + 8 * 3600_000, hub: "bongeunsa", type: "app_open",
    })));
    const place = fakePlaceApi({
      e1: placeJson({ name: "e1", lat: HUBS[0].lat, lng: HUBS[0].lng }),
      e2: placeJson({ name: "e2", lat: HUBS[0].lat, lng: HUBS[0].lng }),
      e3: 403,
      e4: placeJson({ name: "e4", lat: HUBS[0].lat, lng: HUBS[0].lng }),
      farnew: placeJson({ name: "f", lat: HUBS[0].lat, lng: HUBS[0].lng }),
    });
    const local = fakeKakaoLocal([]);
    const { db, n } = countingDb(env.DB);
    const r = await runScheduled({ ...env, DB: db }, { fetcher: routeFetch(local.fetcher, place.fetcher), now: NOW, sleep: async () => {} });
    const last = await env.DB.prepare("SELECT value FROM meta WHERE key = 'cron_last'").first<{ value: string }>();
    return { r, calls: n.calls, place, last };
  }

  it("R38/R11: 격자 수십 칸을 모아야 하는 최악의 본 Cron도 D1 호출은 50번(batch는 1번) 안이다 — 격자 수집은 뒤 단계 몫을 남기고 멈추고, 미수집 보충·집계·기록은 한다", async () => {
    const { r, calls, place, last } = await worstCase(36);
    expect(CRON_D1_CALL_LIMIT).toBe(50);
    expect(calls, `D1 calls ${calls}`).toBeLessThanOrEqual(CRON_D1_CALL_LIMIT);
    expect(r.tiles.collected).toBeGreaterThan(0);
    expect(r.tiles.incomplete).toBeGreaterThan(0); // 남은 격자는 다음 실행
    expect(r.d1Calls).toBeLessThanOrEqual(CRON_D1_CALL_LIMIT - 1);
    // 미수집(가장 먼 칸)을 찾으러 걷고, 만료 후보(최악 8번)는 이번에는 건너뛴다
    expect(r.d1Skipped).toEqual(["expired"]);
    expect(r.rolled).toBe(3);
    expect(last).not.toBeNull();
    expect(place.calls.length).toBeLessThanOrEqual(4);
  });

  it("R38/R10/R44: 상세 쪽 최악(만료 커서 재설정·미수집 6묶음·저장 묶음 실패와 한 곳씩 다시·세 번째 차단·집계·보관 정리)도 D1 호출은 50번 안이다", async () => {
    const { r, calls, place, last } = await worstCase(2);
    expect(calls, `D1 calls ${calls}`).toBeLessThanOrEqual(CRON_D1_CALL_LIMIT);
    expect(r.d1Skipped).toBeUndefined();
    expect(r.tiles.collected).toBe(2);
    // 만료 후보(e1~)로 보충했고, 403으로 세 번째 차단 → 강등 모드, 저장 오류는 기록만 하고 집계·요약은 했다
    expect(place.calls.map((c) => c.id)).toContain("e3");
    expect(r.enrichError).toBe(true);
    const mode = await env.DB.prepare("SELECT value FROM meta WHERE key = 'detail_mode'").first<{ value: string }>();
    expect(JSON.parse(mode!.value)).toMatchObject({ mode: "frozen" });
    expect(r.rolled).toBe(3);
    expect(last).not.toBeNull();
  });

  it("R11: 미수집을 다 채웠다고 본 뒤 더 이른 now로 격자 ID가 늦게 들어와도 다음 Cron이 찾는다", async () => {
    await markFresh(KEYS, NOW);
    const home = tileKeyOf(HUBS[0]);
    await replaceTilePlaces(env.DB, home, ["5001"], NOW, false);
    const place = fakePlaceApi({
      "5001": placeJson({ name: "a", lat: HUBS[0].lat, lng: HUBS[0].lng }),
      "5002": placeJson({ name: "b", lat: HUBS[0].lat, lng: HUBS[0].lng }),
    });
    const run = (t: number) => runScheduled(env, { fetcher: place.fetcher, now: t, sleep: async () => {} });
    await run(NOW + 60_000);
    expect(place.calls.map((c) => c.id)).toEqual(["5001"]);
    // 앞선 커서가 끝까지 가도록 몇 번 더 (미수집 없음 — 다 채웠다)
    for (let i = 2; i <= 6; i++) await run(NOW + i * 60_000);
    // 그 사이 시작했던 요청이 더 이른 now로 늦게 기록한다
    await replaceTilePlaces(env.DB, home, ["5001", "5002"], NOW + 30_000, false);
    await run(NOW + 10 * 60_000);
    expect(place.calls.map((c) => c.id)).toEqual(["5001", "5002"]);
  });

  it("R38/R31: 격자를 하나도 모으지 않은 새 거점의 warm(1000m, 칸 수십 개)도 요청 하나의 D1 호출은 50번 안이다 — 남은 격자는 incomplete·pending more", async () => {
    const local = fakeKakaoLocal([]);
    const place = fakePlaceApi({});
    const app = createApp({
      fetcher: routeFetch(local.fetcher, place.fetcher), now: () => NOW, sleep: async () => {}, rateLimit: async () => true,
    });
    const { db, n } = countingDb(env.DB);
    const h = HUBS[0];
    const res = await callApp(app, `/api/admin/warm?lat=${h.lat}&lng=${h.lng}&radius=1000`, {
      method: "POST", headers: { Authorization: "Bearer test-admin-token" },
    }, { ...env, DB: db });
    const r = await res.json<{ incompleteTiles: number; pending: unknown }>();
    expect(n.calls, `D1 calls ${n.calls}`).toBeLessThanOrEqual(CRON_D1_CALL_LIMIT);
    expect(r.incompleteTiles).toBeGreaterThan(0);
    expect(r.pending).toBe("more");
    expect(local.calls.length).toBeGreaterThan(0);
  });
});
