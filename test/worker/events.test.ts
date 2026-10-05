import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PREWARM_RADIUS } from "../../shared/constants";
import { DAY_MS, kstDayHour } from "../../shared/kst";
import { tilesCoveringCircle } from "../../shared/geo";
import { HUBS } from "../../shared/hubs";
import type { StatsResponse } from "../../shared/events";
import { createApp } from "../../worker/app";
import { d1UsageOn, recordD1Usage } from "../../worker/d1Usage";
import { isRetentionWindow, pruneOldEvents } from "../../worker/events";
import { runScheduled } from "../../worker/maintenance";
import { markTile } from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { seedPlace } from "../helpers/places";

const NOW = 1_800_000_000_000; // 2027-01-15 17:00 KST
const AUTH = { Authorization: "Bearer test-admin-token" };
const ANON = "0b0e7c6e-3f6b-4b8e-9a3e-1c2d3e4f5a6b";
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ev = (o: Record<string, unknown> = {}) => ({ t: "draw", ts: NOW - 1000, hub: "bongeunsa", ...o });

function setup(opts: { allow?: boolean } = {}) {
  const keys: string[] = [];
  const fetcher = routeFetch(fakeKakaoLocal([]).fetcher, fakePlaceApi({}).fetcher);
  const app = createApp({
    fetcher,
    now: () => NOW,
    sleep: async () => {},
    rateLimit: async (_env, key) => {
      keys.push(key);
      return opts.allow ?? true;
    },
  });
  return { app, keys, fetcher };
}

const post = (app: ReturnType<typeof setup>["app"], body: string) =>
  callApp(app, "/api/events", { method: "POST", headers: { "content-type": "application/json" }, body });

const rows = async () =>
  (await env.DB.prepare("SELECT ts, day, hour, anon, session, hub, type, place_id, props FROM events ORDER BY id").all()).results;

type Seed = { anon: string; session: string; ts: number; hub: string; type: string; placeId?: string; props?: object };
async function seed(list: Seed[]) {
  const stmt = env.DB.prepare(
    "INSERT INTO events (ts, day, hour, anon, session, hub, type, place_id, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await env.DB.batch(
    list.map((e) => {
      const { day, hour } = kstDayHour(e.ts);
      return stmt.bind(e.ts, day, hour, e.anon, e.session, e.hub, e.type, e.placeId ?? null, e.props ? JSON.stringify(e.props) : null);
    }),
  );
}

describe("POST /api/events", () => {
  it("R35: 검증한 이벤트를 KST 날짜·시와 함께 저장하고 204, 틀린 이벤트는 버리고 센다", async () => {
    const { app, keys } = setup();
    const res = await post(
      app,
      JSON.stringify({
        anon: ANON,
        session: SESSION,
        events: [
          ev({ props: { candidates: 42, picks: ["1", "2", "3"], radius: 500, party: 2 } }),
          ev({ t: "open_kakao", placeId: "2", props: { rank: 2 }, ts: NOW + 60 * 60_000 }),
          ev({ t: "nope" }),
        ],
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("x-mmj-dropped")).toBe("1");
    expect(keys).toEqual([`ev:${ANON}`]);
    expect(await rows()).toEqual([
      {
        ts: NOW - 1000, day: "2027-01-15", hour: 16, anon: ANON, session: SESSION, hub: "bongeunsa", type: "draw",
        place_id: null, props: '{"radius":500,"party":2,"candidates":42,"picks":["1","2","3"]}',
      },
      // 10분 넘게 앞선 시각은 서버 시각으로
      {
        ts: NOW, day: "2027-01-15", hour: 17, anon: ANON, session: SESSION, hub: "bongeunsa", type: "open_kakao",
        place_id: "2", props: '{"rank":2}',
      },
    ]);
  });

  it("R35: 요청 하나는 db.batch 한 번으로 넣는다", async () => {
    const { app } = setup();
    let batches = 0;
    const DB = new Proxy(env.DB, {
      get(t, k) {
        if (k === "batch") return (s: D1PreparedStatement[]) => ((batches += 1), t.batch(s));
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = createExecutionContext();
    const body = JSON.stringify({ anon: ANON, session: SESSION, events: Array.from({ length: 20 }, () => ev()) });
    const res = await app.fetch(new Request("http://localhost/api/events", { method: "POST", body }), { ...env, DB }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(batches).toBe(1);
    expect(await rows()).toHaveLength(20);
  });

  it("R35: 봉투가 틀리거나(익명 id 형식, 21개 이상, JSON 아님) 8KB를 넘으면 400, 아무것도 저장하지 않는다", async () => {
    const { app } = setup();
    const bodies = [
      JSON.stringify({ anon: "me", session: SESSION, events: [ev()] }),
      JSON.stringify({ anon: ANON, session: SESSION, events: Array.from({ length: 21 }, () => ev()) }),
      "not json",
      JSON.stringify({ anon: ANON, session: SESSION, events: [ev()], pad: "x".repeat(8 * 1024) }),
    ];
    for (const b of bodies) expect((await post(app, b)).status, b.slice(0, 40)).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("R35: IP·User-Agent·Origin은 헤더에 있어도 어떤 열에도 저장하지 않는다", async () => {
    const { app } = setup();
    const res = await callApp(app, "/api/events", {
      method: "POST",
      headers: {
        "content-type": "application/json", "cf-connecting-ip": "203.0.113.77",
        "user-agent": "QA-Agent/9.9", origin: "https://mmj.itmz.me",
      },
      body: JSON.stringify({ anon: ANON, session: SESSION, events: [ev({ t: "share", placeId: "13583324" })] }),
    });
    expect(res.status).toBe(204);
    const all = (await env.DB.prepare("SELECT * FROM events").all()).results;
    expect(all).toHaveLength(1);
    expect(Object.keys(all[0]).sort()).toEqual(["anon", "day", "hour", "hub", "id", "place_id", "props", "session", "ts", "type"]);
    expect(JSON.stringify(all)).not.toMatch(/203\.0\.113\.77|QA-Agent|mmj\.itmz\.me/);
  });

  it("R35: Origin이 있는데 운영 주소나 로컬 개발 주소가 아니면 아무것도 저장하지 않고 204 (제한 키도 쓰지 않는다)", async () => {
    const body = JSON.stringify({ anon: ANON, session: SESSION, events: [ev()] });
    for (const origin of [
      "https://evil.example", "http://mmj.itmz.me", "https://mmj.itmz.me.evil.example", "https://x.mmj.itmz.me", "null",
      "http://172.30.1.2:8080", "http://172.31.1.2:5173", "http://localhost.evil.example", "https://localhost:5173",
    ]) {
      const { app, keys } = setup();
      const res = await callApp(app, "/api/events", { method: "POST", headers: { "content-type": "application/json", origin }, body });
      expect(res.status, origin).toBe(204);
      expect(keys, origin).toEqual([]);
    }
    expect(await rows()).toHaveLength(0);
  });

  it("R35: 운영 주소·로컬 개발 주소 Origin과 Origin 없는 요청은 저장한다", async () => {
    const body = JSON.stringify({ anon: ANON, session: SESSION, events: [ev()] });
    const origins = ["https://mmj.itmz.me", "http://localhost:5173", "http://localhost:4250", "http://127.0.0.1:4250", "http://172.30.12.34:5173", null];
    for (const origin of origins) {
      const { app } = setup();
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (origin) headers.origin = origin;
      expect((await callApp(app, "/api/events", { method: "POST", headers, body })).status, String(origin)).toBe(204);
    }
    expect(await rows()).toHaveLength(origins.length);
  });

  it("R35: 익명 id별 요청 제한(RATE_LIMITER)을 넘으면 저장하지 않고 204로 조용히 넘긴다", async () => {
    const { app } = setup({ allow: false });
    const res = await post(app, JSON.stringify({ anon: ANON, session: SESSION, events: [ev()] }));
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it("R35/R38: 오늘(UTC) D1 쓰기가 D1_WRITE_SOFT_CAP 이상이면 익명 id와 상관없이 저장하지 않고 204", async () => {
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind("d1_written:2027-01-15", "60000").run();
    const { app } = setup();
    const res = await post(app, JSON.stringify({ anon: ANON, session: SESSION, events: [ev()] }));
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(0);
  });

  it("R35/R38: 어제(UTC) 쓰기는 오늘 쓰기 상한에 들어가지 않는다", async () => {
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").bind("d1_written:2027-01-14", "999999").run();
    const { app } = setup();
    await post(app, JSON.stringify({ anon: ANON, session: SESSION, events: [ev()] }));
    expect(await rows()).toHaveLength(1);
  });

  it("R35: 저장이 실패해도 500이 아니라 204로 답한다", async () => {
    const { app } = setup();
    const DB = new Proxy(env.DB, {
      get(t, k) {
        if (k === "batch") return async () => { throw new Error("boom"); };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      const ctx = createExecutionContext();
      const body = JSON.stringify({ anon: ANON, session: SESSION, events: [ev()] });
      const res = await app.fetch(new Request("http://localhost/api/events", { method: "POST", body }), { ...env, DB }, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(204);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      console.error = orig;
    }
  });

  it("R38: /api/events는 요청마다 하는 사용량 UPSERT 대신 같은 배치에서 쓰기 추정치(이벤트당 4행)만 더한다", async () => {
    const { app } = setup();
    let prepared: string[] = [];
    const DB = new Proxy(env.DB, {
      get(t, k) {
        if (k === "prepare") return (q: string) => (prepared.push(q), t.prepare(q));
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const ctx = createExecutionContext();
    const body = JSON.stringify({ anon: ANON, session: SESSION, events: [ev(), ev(), ev()] });
    const res = await app.fetch(new Request("http://localhost/api/events", { method: "POST", body }), { ...env, DB }, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(204);
    expect(await rows()).toHaveLength(3);
    expect(await d1UsageOn(env.DB, "2027-01-15")).toEqual({ read: 0, written: 12 });
    // 읽기 키는 건드리지 않는다
    expect(prepared.filter((q) => q.includes("INSERT INTO meta"))).toHaveLength(1);
    prepared = [];
    // 이벤트가 없는 요청(전부 버림)은 meta에 아무것도 쓰지 않는다
    await app.fetch(
      new Request("http://localhost/api/events", { method: "POST", body: JSON.stringify({ anon: ANON, session: SESSION, events: [ev({ hub: "x" })] }) }),
      { ...env, DB },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(prepared.filter((q) => q.includes("INSERT INTO meta"))).toHaveLength(0);
  });

  it("R35: 유효한 이벤트가 하나도 없으면 D1에 쓰지 않는다", async () => {
    const { app } = setup();
    const res = await post(app, JSON.stringify({ anon: ANON, session: SESSION, events: [ev({ hub: "x" })] }));
    expect(res.status).toBe(204);
    expect(res.headers.get("x-mmj-dropped")).toBe("1");
    expect(await rows()).toHaveLength(0);
  });
});

describe("보관 기간", () => {
  const KST_0402 = Date.UTC(2027, 0, 14, 19, 2); // 2027-01-15 04:02 KST

  it("R35: 정리는 KST 04:00~04:04 한 번의 Cron에서만 돈다", () => {
    expect(isRetentionWindow(KST_0402)).toBe(true);
    expect(isRetentionWindow(Date.UTC(2027, 0, 14, 19, 0))).toBe(true);
    expect(isRetentionWindow(Date.UTC(2027, 0, 14, 19, 5))).toBe(false);
    expect(isRetentionWindow(Date.UTC(2027, 0, 14, 20, 2))).toBe(false);
    expect(isRetentionWindow(NOW)).toBe(false);
  });

  it("R35: 90일 지난 날의 이벤트와 D1 사용량 기록을 지운다", async () => {
    const base = { anon: ANON, session: SESSION, hub: "ddp", type: "app_open" };
    await seed([
      { ...base, ts: KST_0402 - 91 * DAY_MS },
      { ...base, ts: KST_0402 - 90 * DAY_MS },
      { ...base, ts: KST_0402 - 89 * DAY_MS },
    ]);
    await recordD1Usage(env.DB, { read: 5, written: 1 }, KST_0402 - 91 * DAY_MS);
    await recordD1Usage(env.DB, { read: 7, written: 1 }, KST_0402);
    await pruneOldEvents(env.DB, KST_0402);
    expect((await rows()).map((r) => r.day)).toEqual(["2026-10-17", "2026-10-18"]);
    // 사용량 키는 UTC 날짜다 (R38): KST 04:02는 아직 전날 UTC
    expect(await d1UsageOn(env.DB, "2026-10-15")).toEqual({ read: 0, written: 0 });
    expect(await d1UsageOn(env.DB, "2027-01-14")).toEqual({ read: 7, written: 1 });
  });

  it("R35: Cron은 정리 시간에만 오래된 이벤트를 지운다 (읽기 예산을 넘은 날에도)", async () => {
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    await seed([{ anon: ANON, session: SESSION, hub: "ddp", type: "app_open", ts: KST_0402 - 100 * DAY_MS }]);
    const { fetcher } = setup();
    await runScheduled(env, { fetcher, now: KST_0402 + 60 * 60_000, sleep: async () => {} });
    expect(await rows()).toHaveLength(1);
    await recordD1Usage(env.DB, { read: 9_000_000, written: 0 }, KST_0402);
    await runScheduled(env, { fetcher, now: KST_0402, sleep: async () => {} });
    expect(await rows()).toHaveLength(0);
  });
});

describe("GET /api/admin/stats", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const C = "cccccccc-0000-4000-8000-000000000003";
  const D = "dddddddd-0000-4000-8000-000000000004";
  const s = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const noonToday = Date.UTC(2027, 0, 15, 3, 10); // 12:10 KST
  const onePm = Date.UTC(2027, 0, 15, 4, 20); // 13:20 KST
  const noonYesterday = noonToday - DAY_MS;

  async function seedScenario() {
    await seedPlace(env.DB, "2", 37.5, 127.0, { name: "가게2", now: NOW });
    await seed([
      // A: 오늘 봉은사 — 뽑기, 다시 뽑기, 공유, 카드 펼침 2번, 카카오맵(2번째)
      { anon: A, session: s(1), ts: noonToday, hub: "bongeunsa", type: "app_open" },
      { anon: A, session: s(1), ts: noonToday, hub: "bongeunsa", type: "draw", props: { picks: ["1", "2", "3"], candidates: 40 } },
      { anon: A, session: s(1), ts: noonToday, hub: "bongeunsa", type: "redraw", props: { picks: ["2", "4", "5"], candidates: 40 } },
      { anon: A, session: s(1), ts: noonToday, hub: "bongeunsa", type: "share", props: { picks: ["2", "4", "5"] } },
      { anon: A, session: s(1), ts: noonToday, hub: "bongeunsa", type: "expand_card", placeId: "2", props: { rank: 1 } },
      { anon: A, session: s(1), ts: noonToday, hub: "bongeunsa", type: "expand_card", placeId: "4", props: { rank: 2 } },
      { anon: A, session: s(1), ts: noonToday, hub: "bongeunsa", type: "open_kakao", placeId: "4", props: { rank: 2 } },
      // A: 어제 봉은사
      { anon: A, session: s(2), ts: noonYesterday, hub: "bongeunsa", type: "app_open" },
      { anon: A, session: s(2), ts: noonYesterday, hub: "bongeunsa", type: "draw", props: { picks: ["2", "6", "7"] } },
      // B: 오늘 동대문 13시
      { anon: B, session: s(3), ts: onePm, hub: "ddp", type: "app_open" },
      { anon: B, session: s(3), ts: onePm, hub: "ddp", type: "draw", props: { picks: ["8", "9", "2"] } },
      { anon: B, session: s(3), ts: onePm, hub: "ddp", type: "open_kakao", placeId: "8", props: { rank: 1 } },
      { anon: B, session: s(3), ts: onePm, hub: "ddp", type: "exclude_place", placeId: "2", props: { rank: 3 } },
      { anon: B, session: s(3), ts: onePm, hub: "ddp", type: "filter_change", props: { radius: 300 } },
      // D: 공유 링크로 들어옴
      { anon: D, session: s(5), ts: onePm, hub: "ddp", type: "app_open" },
      { anon: D, session: s(5), ts: onePm, hub: "ddp", type: "share_open", props: { picks: ["1"] } },
      // C: 범위 밖 (10일 전)
      { anon: C, session: s(4), ts: noonToday - 10 * DAY_MS, hub: "ddp", type: "app_open" },
      { anon: C, session: s(4), ts: noonToday - 10 * DAY_MS, hub: "ddp", type: "draw", props: { picks: ["1", "3", "9"] } },
    ]);
  }

  const get = async (app: ReturnType<typeof setup>["app"], q: string) => callApp(app, `/api/admin/stats${q}`, { headers: AUTH });

  it("R36: 토큰이 없으면 401, 잘못된 범위·거점은 400", async () => {
    const { app } = setup();
    expect((await callApp(app, "/api/admin/stats?days=7")).status).toBe(401);
    expect((await get(app, "?days=0")).status).toBe(400);
    expect((await get(app, "?days=31")).status).toBe(400);
    expect((await get(app, "?days=7&hub=gangnam")).status).toBe(400);
  });

  it("R36: 최근 N일(오늘 포함, KST)의 일별 사용자·세션·행동, 시간대, 거점, 상위 가게, 전환율을 집계한다", async () => {
    await seedScenario();
    const { app } = setup();
    const res = await get(app, "?days=7&hub=all");
    expect(res.status).toBe(200);
    const r = await res.json<StatsResponse>();
    expect(r.range).toEqual({ from: "2027-01-09", to: "2027-01-15", days: 7, hub: "all" });
    expect(r.daily.map((d) => d.day)).toEqual([
      "2027-01-09", "2027-01-10", "2027-01-11", "2027-01-12", "2027-01-13", "2027-01-14", "2027-01-15",
    ]);
    expect(r.daily[0]).toEqual({ day: "2027-01-09", users: 0, sessions: 0, draws: 0, redraws: 0, shares: 0, openKakao: 0, shareOpens: 0 });
    expect(r.daily[5]).toEqual({ day: "2027-01-14", users: 1, sessions: 1, draws: 1, redraws: 0, shares: 0, openKakao: 0, shareOpens: 0 });
    expect(r.daily[6]).toEqual({ day: "2027-01-15", users: 3, sessions: 3, draws: 2, redraws: 1, shares: 1, openKakao: 2, shareOpens: 1 });
    expect(r.totals).toEqual({
      users: 3, sessions: 4, draws: 3, redraws: 1, shares: 1, openKakao: 2, shareOpens: 1, expands: 2, excludes: 1, autoDraws: 0,
    });
    const hourly = Array(24).fill(0);
    hourly[12] = 3;
    hourly[13] = 1;
    expect(r.hourly).toEqual(hourly);
    expect(r.hubs).toEqual([
      { hub: "bongeunsa", users: 1, sessions: 2, draws: 3, shares: 1 },
      { hub: "ddp", users: 2, sessions: 2, draws: 1, shares: 0 },
    ]);
    expect(r.top[0]).toEqual({ placeId: "2", name: "가게2", count: 4 });
    expect(r.top.slice(1).map((t) => [t.placeId, t.count])).toEqual(
      ["1", "3", "4", "5", "6", "7", "8", "9"].map((id) => [id, 1]),
    );
    expect(r.top[1].name).toBeNull();
    expect(r.ranks).toEqual({ expand: [1, 1, 0], kakao: [1, 1, 0], exclude: [0, 0, 1] });
    expect(r.conversion.drawSessions).toBe(3);
    expect(r.conversion.toShare).toBeCloseTo(1 / 3);
    expect(r.conversion.toKakao).toBeCloseTo(2 / 3);
    expect(r.drawsPerSession).toBe(1);
  });

  it("R36/R39: 자동 뽑기는 뽑기·시간대·거점·많이 뽑힌 가게·전환율·세션당 뽑기에서 빼고 totals.autoDraws로 따로 센다", async () => {
    await seed([
      // 자동 뽑기만 보고 공유한 세션 → 전환율의 분모·분자 모두에서 빠진다
      { anon: A, session: s(6), ts: noonToday, hub: "bongeunsa", type: "app_open" },
      { anon: A, session: s(6), ts: noonToday, hub: "bongeunsa", type: "draw", props: { picks: ["1", "2", "3"], auto: true } },
      { anon: A, session: s(6), ts: noonToday, hub: "bongeunsa", type: "share", props: { picks: ["1", "2", "3"] } },
      // 자동 뽑기 뒤 직접 다시 뽑고 카카오맵
      { anon: B, session: s(7), ts: onePm, hub: "ddp", type: "app_open" },
      { anon: B, session: s(7), ts: onePm, hub: "ddp", type: "draw", props: { picks: ["4", "5", "6"], auto: true } },
      { anon: B, session: s(7), ts: onePm, hub: "ddp", type: "redraw", props: { picks: ["7", "8", "9"] } },
      { anon: B, session: s(7), ts: onePm, hub: "ddp", type: "open_kakao", placeId: "7", props: { rank: 1 } },
    ]);
    const { app } = setup();
    const r = await (await get(app, "?days=1")).json<StatsResponse>();
    expect(r.totals).toMatchObject({ sessions: 2, draws: 0, redraws: 1, autoDraws: 2, shares: 1, openKakao: 1 });
    expect(r.daily[0]).toMatchObject({ draws: 0, redraws: 1 });
    const hourly = Array(24).fill(0);
    hourly[13] = 1;
    expect(r.hourly).toEqual(hourly);
    expect(r.hubs).toEqual([
      { hub: "bongeunsa", users: 1, sessions: 1, draws: 0, shares: 1 },
      { hub: "ddp", users: 1, sessions: 1, draws: 1, shares: 0 },
    ]);
    expect(r.top.map((t) => t.placeId)).toEqual(["7", "8", "9"]);
    expect(r.conversion).toEqual({ drawSessions: 1, toShare: 0, toKakao: 1 });
    expect(r.drawsPerSession).toBe(0.5);
  });

  it("R36: 거점을 고르면 그 거점 이벤트만, 오늘만 고르면 오늘만 센다", async () => {
    await seedScenario();
    const { app } = setup();
    const ddp = await (await get(app, "?days=7&hub=ddp")).json<StatsResponse>();
    expect(ddp.totals).toMatchObject({ users: 2, sessions: 2, draws: 1, redraws: 0, openKakao: 1, shareOpens: 1 });
    expect(ddp.hubs).toEqual([{ hub: "ddp", users: 2, sessions: 2, draws: 1, shares: 0 }]);
    expect(ddp.top.map((t) => t.placeId)).toEqual(["2", "8", "9"]);
    const today = await (await get(app, "?days=1")).json<StatsResponse>();
    expect(today.range).toEqual({ from: "2027-01-15", to: "2027-01-15", days: 1, hub: "all" });
    expect(today.totals).toMatchObject({ users: 3, sessions: 3, draws: 2, redraws: 1 });
  });

  it("R36/R38: 오늘(KST) D1 읽기·쓰기 추정치와 소프트 한도를 함께 준다", async () => {
    await recordD1Usage(env.DB, { read: 1234, written: 56 }, NOW);
    const { app } = setup();
    const r = await (await get(app, "?days=7")).json<StatsResponse>();
    expect(r.d1Today.read).toBeGreaterThanOrEqual(1234);
    expect(r.d1Today.written).toBe(56);
    expect(r.d1Today.readSoftCap).toBe(3_000_000);
    expect(r.conversion).toEqual({ drawSessions: 0, toShare: null, toKakao: null });
    expect(r.drawsPerSession).toBeNull();
    expect(r.top).toEqual([]);
  });
});
