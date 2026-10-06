import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PREWARM_RADIUS } from "../../shared/constants";
import type { BehaviorData, OpsData, OverviewData } from "../../shared/dashboard";
import { tilesCoveringCircle } from "../../shared/geo";
import { HUBS } from "../../shared/hubs";
import { utcDay } from "../../shared/kst";
import { createApp, type ResponseCache } from "../../worker/app";
import { recordCronRun } from "../../worker/d1Usage";
import { markTile, replaceTilePlaces, saveDetailFailure } from "../../worker/repo";
import { runRollups } from "../../worker/rollup";
import { callApp } from "../helpers/callApp";
import { anonN, seedEvents, sessN, type Seed } from "../helpers/events";
import { fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { recordingDb } from "../helpers/recordDb";
import { seedPlace } from "../helpers/places";

const kst = (day: string, h: number, m = 0, s = 0) => {
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h - 9, m, s);
};
const TODAY = "2027-01-15";
const NOW = kst(TODAY, 17); // 2027-01-15 17:00 KST (= 1_800_000_000_000)
const AUTH = { Authorization: "Bearer test-admin-token" };

/** 테스트용 응답 캐시 (Workers Cache API 대역) */
function memCache() {
  const store = new Map<string, Response>();
  const cache: ResponseCache & { store: Map<string, Response> } = {
    store,
    async match(req) {
      return store.get(req.url)?.clone();
    },
    async put(req, res) {
      store.set(req.url, res.clone());
    },
  };
  return cache;
}

function setup(opts: { now?: () => number; cache?: ResponseCache; allow?: () => boolean } = {}) {
  const fetcher = routeFetch(fakeKakaoLocal([]).fetcher, fakePlaceApi({}).fetcher);
  return createApp({
    fetcher, now: opts.now ?? (() => NOW), sleep: async () => {}, rateLimit: async () => true, cache: opts.cache,
    adminRateLimit: async () => (opts.allow ? opts.allow() : true),
  });
}
const get = (app: ReturnType<typeof setup>, q: string, headers: Record<string, string> = AUTH) =>
  callApp(app, `/api/admin/dashboard?${q}`, { headers });

/** 하루치: 직접 뽑기 세션 하나(결정), 자동 뽑기 세션 하나(그냥 떠남) */
function day(d: string, n: number, hub = "bongeunsa"): Seed[] {
  const e = (s: number, type: string, at: number, extra: Partial<Seed> = {}): Seed => ({
    anon: anonN(n + s), session: sessN(n * 10 + s), hub, type, ts: at, ...extra,
  });
  return [
    e(0, "app_open", kst(d, 12, 0)),
    e(0, "draw", kst(d, 12, 0, 10), { props: { picks: ["101", "102", "103"] } }),
    e(0, "expand_card", kst(d, 12, 0, 30), { placeId: "101", props: { rank: 1 } }),
    e(0, "share", kst(d, 12, 1, 0), { placeId: "101", props: { picks: ["101"], confirm: true, rank: 1 } }),
    e(1, "app_open", kst(d, 13, 0)),
    e(1, "draw", kst(d, 13, 0, 5), { props: { picks: ["104", "105", "106"], auto: true } }),
  ];
}

describe("GET /api/admin/dashboard", () => {
  it("R60: 관리자 인증·제한은 다른 관리자 API와 같다 (토큰 없으면 401, ADMIN_LIMITER를 넘으면 맞는 토큰도 429)", async () => {
    expect((await get(setup(), "tab=overview", {})).status).toBe(401);
    expect((await get(setup(), "tab=overview", { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await get(setup({ allow: () => false }), "tab=overview")).status).toBe(429);
  });

  it("R60: 잘못된 탭·날짜·거점, 90일 넘는 기간, 미래·뒤집힌 기간은 400", async () => {
    const app = setup();
    for (const q of [
      "tab=nope", "from=2027-1-1", "to=2027-02-30", "hub=gangnam", "from=2026-10-01&to=2027-01-15",
      "from=2027-01-10&to=2027-01-16", "from=2027-01-12&to=2027-01-10", "compare=yes",
    ]) {
      expect((await get(app, q)).status, q).toBe(400);
    }
    expect((await get(app, "from=2026-10-18&to=2027-01-15")).status).toBe(200); // 90일
  });

  it("R57: 개요 — KPI(이전 기간 대비, 14일 스파크라인), 일별 직접·자동 뽑기, 요일 × 시간 히트맵, 거점별, 날마다 출처(집계·실시간)", async () => {
    await seedEvents([
      ...day("2027-01-08", 100), // 이전 기간
      ...day("2027-01-13", 200),
      ...day("2027-01-14", 300, "ddp"),
      ...day(TODAY, 400),
    ]);
    // Cron이 어제까지 집계했다
    for (let i = 0; i < 5 && (await runRollups(env.DB, kst(TODAY, 5))) > 0; i++);
    const res = await get(setup(), "tab=overview&from=2027-01-13&to=2027-01-15&compare=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const d = await res.json<OverviewData>();
    expect(d.range).toEqual({ from: "2027-01-13", to: TODAY, days: 3, hub: "all", compare: true });
    expect(d.prev).toEqual({ from: "2027-01-10", to: "2027-01-12" });
    expect(d.rollupThrough).toBe("2027-01-14");
    expect(d.sources).toEqual({ "2027-01-13": "rollup", "2027-01-14": "rollup", [TODAY]: "live" });
    expect(d.kpis.sessions).toMatchObject({ value: 6, prev: 0 });
    expect(d.kpis.users.value).toBe(2); // 일평균
    expect(d.kpis.decisionRate.value).toBeCloseTo(0.5);
    expect(d.kpis.drawsPerSession.value).toBeCloseTo(0.5);
    expect(d.kpis.sessions.spark).toHaveLength(14);
    expect(d.kpis.sessions.spark.slice(-8)).toEqual([2, 0, 0, 0, 0, 2, 2, 2]);
    expect(d.daily.map((x) => [x.day, x.source, x.manual, x.auto])).toEqual([
      ["2027-01-13", "rollup", 1, 1], ["2027-01-14", "rollup", 1, 1], [TODAY, "live", 1, 1],
    ]);
    // 2027-01-13은 수요일(2), 12시·13시
    expect([d.heatmap[2][12], d.heatmap[2][13], d.heatmap[3][12], d.heatmap[4][13]]).toEqual([1, 1, 1, 1]);
    expect(d.hubs.find((h) => h.hub === "ddp")).toMatchObject({ sessions: 2, decided: 1, draws: 1, shares: 1 });
    expect(d.hubs.find((h) => h.hub === "bongeunsa")).toMatchObject({ sessions: 4 });
    expect(d.hubs.some((h) => h.hub === "*")).toBe(false);
  });

  it("R57: 거점을 고르면 그 거점 지표만 센다", async () => {
    await seedEvents([...day("2027-01-14", 300, "ddp"), ...day(TODAY, 400)]);
    await runRollups(env.DB, kst(TODAY, 5));
    const d = await (await get(setup(), "tab=overview&from=2027-01-14&to=2027-01-15&hub=ddp")).json<OverviewData>();
    expect(d.kpis.sessions.value).toBe(2);
    expect(d.hubs.map((h) => h.hub)).toEqual(["ddp"]);
  });

  it("R59: 집계가 밀린 날은 실시간으로 세지 않고 missing으로 둔다 (실시간은 오늘·어제까지만)", async () => {
    await seedEvents([...day("2027-01-11", 100), ...day("2027-01-14", 200), ...day(TODAY, 300)]);
    const d = await (await get(setup(), "tab=overview&from=2027-01-11&to=2027-01-15")).json<OverviewData>();
    expect(d.rollupThrough).toBeNull();
    expect(d.sources).toEqual({
      "2027-01-11": "missing", "2027-01-12": "missing", "2027-01-13": "missing", "2027-01-14": "live", [TODAY]: "live",
    });
    expect(d.kpis.sessions.value).toBe(4);
    expect(d.alerts.some((a) => a.code === "rollup")).toBe(true);
  });

  it("R58: 사용자 행태 — 기간 합계, 이전 기간, 재방문 코호트(관찰 못 한 칸은 null), 많이 뽑힌·공유된·빼진 가게(이름은 places)", async () => {
    await seedPlace(env.DB, "101", 37.5, 127.0, { name: "가게101", now: NOW });
    await seedEvents([
      ...day("2027-01-04", 100),
      { anon: anonN(100), session: sessN(9999), hub: "bongeunsa", type: "app_open", ts: kst("2027-01-05", 12) }, // D1 재방문
      ...day("2027-01-13", 200),
      ...day(TODAY, 300),
      { anon: anonN(300), session: sessN(3000), hub: "bongeunsa", type: "exclude_place", ts: kst(TODAY, 12, 5), placeId: "105", props: { rank: 2 } },
    ]);
    for (let i = 0; i < 10 && (await runRollups(env.DB, kst(TODAY, 5))) > 0; i++);
    const d = await (await get(setup(), "tab=behavior&from=2027-01-04&to=2027-01-15&compare=0")).json<BehaviorData>();
    expect(d.prevTotals).toBeNull();
    expect(d.totals).toMatchObject({ sessions: 7, funnel_draw: 6, funnel_expand: 3, funnel_confirm: 3, auto_left: 3, confirm_r1: 3 });
    expect(Object.keys(d.totals).some((k) => k.startsWith("pick:") || k.startsWith("cohort_"))).toBe(false);
    expect(d.places.picked[0]).toEqual({ placeId: "101", name: "가게101", count: 3 });
    expect(d.places.shared[0]).toEqual({ placeId: "101", name: "가게101", count: 3 });
    expect(d.places.excluded).toEqual([{ placeId: "105", name: null, count: 1 }]);
    expect(d.cohorts.map((c) => c.week)).toEqual(["2027-01-04", "2027-01-11"]);
    // 2027-01-04 주: 2명, 그중 1명이 다음 날 다시 옴. 집계는 01-14까지:
    // D1은 주 마지막 날(01-10) + 1 ≤ 01-14라 다 관찰, D7은 주 첫날 + 7(01-11)만 지나 일부(partial), D14·D28은 아직 못 봄(null)
    expect(d.cohorts[0]).toEqual({ week: "2027-01-04", size: 2, ret: [1, 0, null, null], partial: [false, true, false, false] });
    expect(d.cohorts[1].size).toBe(2);
  });

  it("R60: 운영 — D1 사용량·소프트 한도·초기화 시각, 카카오 쿨다운·차단 횟수, 마지막 Cron, 거점별 데이터 상태, 오늘 이벤트 수", async () => {
    const hub = HUBS.find((h) => h.id === "pangyo")!;
    const keys = tilesCoveringCircle(hub, PREWARM_RADIUS);
    await replaceTilePlaces(env.DB, keys[0], ["1", "2", "3"], NOW - 1000, false);
    await markTile(env.DB, keys[1], NOW - 8 * 24 * 3600_000, 0, false); // 7일 지나 다시 모을 칸
    await seedPlace(env.DB, "1", hub.lat, hub.lng, { name: "판교1", now: NOW - 2 * 24 * 3600_000 });
    await saveDetailFailure(env.DB, "2", "http_500", NOW);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO meta VALUES ('place_blocked_until', ?)").bind(String(NOW + 60_000)),
      env.DB.prepare("INSERT INTO meta VALUES (?, '2')").bind(`block_count:${TODAY}`),
    ]);
    await recordCronRun(env.DB, { read: 1000, written: 10 }, NOW - 120_000, { at: NOW - 120_000, collected: 1, incomplete: 0, enriched: 2, failed: 0, calls: 5, rolled: 0 });
    await seedEvents(day(TODAY, 100));
    const d = await (await get(setup(), "tab=ops")).json<OpsData>();
    expect(d.ops.budget).toMatchObject({ utcDay: utcDay(NOW), readSoftCap: 3_000_000, writeSoftCap: 60_000, resetAt: Date.UTC(2027, 0, 16) });
    expect(d.ops.budget.read).toBeGreaterThanOrEqual(1000);
    expect(d.ops.kakao).toEqual({ blockedUntil: NOW + 60_000, frozen: null, blocksToday: 2 });
    expect(d.ops.cron).toMatchObject({ at: NOW - 120_000, enriched: 2, calls: 5 });
    const p = d.hubs!.find((h) => h.hub === "pangyo")!;
    expect(p).toMatchObject({ places: 3, ok: 1, failed: 1, pending: 1, visible: 1, listReady: 1, tiles: keys.length });
    expect(p.incompleteTiles).toBe(keys.length - 1);
    expect(p.oldestOkAt).toBe(NOW - 2 * 24 * 3600_000);
    expect(p.lastTileAt).toBe(NOW - 1000);
    expect(d.eventsToday).toBe(6);
    expect(d.alerts.map((a) => a.code)).toEqual(expect.arrayContaining(["cooldown", "hub:pangyo"]));
  });

  it("R59/R60: 같은 요청은 60초 동안 엣지 캐시에서 D1을 읽지 않고 답한다 (매개변수가 다르면 새로 계산, fresh=1이면 다시 계산)", async () => {
    await seedEvents(day(TODAY, 100));
    const cache = memCache();
    let now = NOW;
    const app = setup({ cache, now: () => now });
    const first = await (await get(app, "tab=overview")).json<OverviewData>();
    const { db, log } = recordingDb(env.DB);
    const call = (q: string) => callApp(app, `/api/admin/dashboard?${q}`, { headers: AUTH }, { ...env, DB: db });
    const again = await call("tab=overview");
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(await again.json()).toEqual(first);
    expect(log).toEqual([]);
    await call("tab=overview&fresh=1");
    expect(log.some((x) => x.sql.includes("FROM meta"))).toBe(true);
    log.length = 0;
    await call("tab=overview&hub=ddp");
    expect(log.length).toBeGreaterThan(0);
    log.length = 0;
    now = NOW + 61_000;
    await call("tab=overview");
    expect(log.some((x) => x.sql.includes("FROM meta"))).toBe(true);
  });

  it("R59: 오늘 실시간 집계는 5분 동안 탭·거점이 함께 쓴다 (events를 다시 읽지 않는다)", async () => {
    await seedEvents(day(TODAY, 100));
    const cache = memCache();
    const app = setup({ cache });
    await get(app, "tab=overview");
    const { db, log } = recordingDb(env.DB);
    const call = (q: string) => callApp(app, `/api/admin/dashboard?${q}`, { headers: AUTH }, { ...env, DB: db });
    // 행태 탭은 개요가 센 core를 다시 쓰고 detail만 센다
    await call("tab=behavior&hub=ddp");
    expect(log.some((x) => x.sql.includes("GROUP BY session"))).toBe(false);
    expect(log.some((x) => x.sql.includes("'$.picks'"))).toBe(true);
    log.length = 0;
    await call("tab=behavior&hub=bongeunsa");
    await call("tab=overview&hub=ddp");
    expect(log.filter((x) => /FROM events/.test(x.sql))).toEqual([]);
  });

  it("R59: 개요는 실시간 집계 중 세션·이벤트 문장만, 운영은 오늘 이벤트 수(색인 count)만 읽는다 — 필터·가게는 행태 탭에서만", async () => {
    await seedEvents(day(TODAY, 100));
    const app = setup();
    const { db, log } = recordingDb(env.DB);
    const call = (q: string) => callApp(app, `/api/admin/dashboard?${q}`, { headers: AUTH }, { ...env, DB: db });
    await call("tab=overview&from=2027-01-15&to=2027-01-15");
    expect(log.some((x) => x.sql.includes("GROUP BY session"))).toBe(true);
    expect(log.some((x) => x.sql.includes("'filter_change'") || x.sql.includes("'$.picks'"))).toBe(false);
    log.length = 0;
    await call("tab=ops");
    expect(log.some((x) => x.sql.includes("GROUP BY session") || x.sql.includes("'$.picks'"))).toBe(false);
    log.length = 0;
    await call("tab=behavior&from=2027-01-15&to=2027-01-15");
    expect(log.some((x) => x.sql.includes("'$.picks'"))).toBe(true);
  });

  it("R38/R59: 오늘 읽기가 소프트 한도의 절반을 넘었으면 실시간 집계를 하지 않는다", async () => {
    await seedEvents(day(TODAY, 100));
    await env.DB.prepare("INSERT INTO meta VALUES (?, '1500000')").bind(`d1_read:${utcDay(NOW)}`).run();
    const d = await (await get(setup(), "tab=overview&from=2027-01-15&to=2027-01-15")).json<OverviewData>();
    expect(d.sources).toEqual({ [TODAY]: "missing" });
    expect(d.kpis.sessions.value).toBeNull();
  });

  it("R38/R59: 같은 가드로 거점별 데이터 상태(격자·가게 수천 행)도 캐시에 없으면 계산하지 않는다", async () => {
    await env.DB.prepare("INSERT INTO meta VALUES (?, '1500000')").bind(`d1_read:${utcDay(NOW)}`).run();
    const { db, log } = recordingDb(env.DB);
    const res = await callApp(setup(), "/api/admin/dashboard?tab=ops", { headers: AUTH }, { ...env, DB: db });
    const d = await res.json<OpsData>();
    expect(d.hubs).toBeNull();
    expect(d.hubsComputedAt).toBeNull();
    expect(log.some((x) => x.sql.includes("tile_places"))).toBe(false);
  });

  it("R59: 실제 Workers 캐시(caches.default)에 들어가서, 같은 요청을 다시 열면 D1을 거의 읽지 않는다", async () => {
    await seedEvents(day(TODAY, 100));
    const app = setup({ cache: caches.default });
    // 다른 테스트와 캐시 키가 겹치지 않게 이 테스트만 쓰는 기간·거점
    const q = "tab=overview&from=2027-01-03&to=2027-01-15&hub=naebang";
    const first = await get(app, q);
    expect(first.status).toBe(200);
    const { db, log } = recordingDb(env.DB);
    const again = await callApp(app, `/api/admin/dashboard?${q}`, { headers: AUTH }, { ...env, DB: db });
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(await again.json()).toEqual(await first.json());
    expect(log.reduce((s, x) => s + x.read, 0)).toBe(0);
    // 응답 캐시가 아니어도(다른 비교 설정) 실시간·거점 상태는 캐시에서 온다
    log.length = 0;
    await callApp(app, `/api/admin/dashboard?${q}&compare=0`, { headers: AUTH }, { ...env, DB: db });
    expect(log.some((x) => /FROM events|tile_places/.test(x.sql))).toBe(false);
  });
});
