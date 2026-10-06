import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ROLLUP_BUDGET_SHARE, ROLLUP_DAYS_PER_RUN, ROLLUP_MAX_DAYS_PER_UTC_DAY, dayList, isKnownMetric } from "../../shared/dashboard";
import {
  cohortStatements, liveDayMetrics, pruneRollups, rollupDayStatements, rollupRetryMs, rollupThrough, runRollups, lastRollableDay,
} from "../../worker/rollup";
import { kstDay, utcDay } from "../../shared/kst";
import { runScheduled } from "../../worker/maintenance";
import { fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { recordingDb } from "../helpers/recordDb";
import { anonN, metricMap, seedEvents, sessN, type Seed } from "../helpers/events";

/** KST 날짜·시각 → epoch ms */
const kst = (day: string, h: number, m = 0, s = 0) => {
  const [y, mo, d] = day.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h - 9, m, s);
};
const D = "2027-01-14";

/** 하루 시나리오 (R58 정의 확인용). 세션 6개, 익명 id 5개, 거점 2곳 */
function scenario(): Seed[] {
  const e = (n: number, s: number, hub: string, type: string, at: number, extra: Partial<Seed> = {}): Seed => ({
    anon: anonN(n), session: sessN(s), hub, type, ts: at, ...extra,
  });
  return [
    // s1 (id 1, 봉은사): 자동 뽑기 → 1번 카드 펼침 → 카카오맵 (20초 만에 결정 = 자동 뽑기 수용)
    e(1, 1, "bongeunsa", "app_open", kst(D, 12, 0, 0)),
    e(1, 1, "bongeunsa", "draw", kst(D, 12, 0, 5), { props: { picks: ["1", "2", "3"], auto: true } }),
    e(1, 1, "bongeunsa", "expand_card", kst(D, 12, 0, 20), { placeId: "1", props: { rank: 1 } }),
    e(1, 1, "bongeunsa", "open_kakao", kst(D, 12, 0, 25), { placeId: "1", props: { rank: 1 } }),
    // s2 (id 2, 봉은사): 직접 뽑기(완화 섞임) + 다시 뽑기 3번 → 2번 카드 펼침 → "여기로 가요" (3분)
    e(2, 2, "bongeunsa", "app_open", kst(D, 12, 10, 0)),
    e(2, 2, "bongeunsa", "filter_change", kst(D, 12, 10, 1), {
      props: { radius: 300, party: 2, groups: ["korean", "japanese"], priceCap: "10000", minRating: 3.5, openOnly: true },
    }),
    e(2, 2, "bongeunsa", "filter_change", kst(D, 12, 10, 2), {
      props: { radius: 1000, party: 4, groups: [], priceCap: "all", minRating: 0, openOnly: false },
    }),
    e(2, 2, "bongeunsa", "draw", kst(D, 12, 10, 10), { props: { picks: ["4", "5", "6"], relaxed: true } }),
    e(2, 2, "bongeunsa", "redraw", kst(D, 12, 10, 20), { props: { picks: ["1", "7", "8"] } }),
    e(2, 2, "bongeunsa", "redraw", kst(D, 12, 10, 30), { props: { picks: ["1", "7", "9"] } }),
    e(2, 2, "bongeunsa", "redraw", kst(D, 12, 10, 40), { props: { picks: ["7", "10", "11"] } }),
    e(2, 2, "bongeunsa", "exclude_place", kst(D, 12, 10, 50), { placeId: "9", props: { rank: 3 } }),
    e(2, 2, "bongeunsa", "expand_card", kst(D, 12, 11, 0), { placeId: "7", props: { rank: 2 } }),
    e(2, 2, "bongeunsa", "share", kst(D, 12, 13, 10), { placeId: "7", props: { picks: ["7"], confirm: true, rank: 2 } }),
    // s3 (id 3, 동대문): 자동 뽑기 → 직접 다시 뽑기, 결정 없음
    e(3, 3, "ddp", "app_open", kst(D, 13, 5, 0)),
    e(3, 3, "ddp", "draw", kst(D, 13, 5, 2), { props: { picks: ["12", "13", "14"], auto: true } }),
    e(3, 3, "ddp", "redraw", kst(D, 13, 5, 30), { props: { picks: ["1", "2", "3"] } }),
    e(3, 3, "ddp", "empty_result", kst(D, 13, 6, 0), { props: { candidates: 0 } }),
    // s4 (id 4, 동대문): 자동 뽑기만 하고 떠남
    e(4, 4, "ddp", "app_open", kst(D, 13, 30, 0)),
    e(4, 4, "ddp", "draw", kst(D, 13, 30, 2), { props: { picks: ["12", "13", "15"], auto: true } }),
    // s5 (id 5, 동대문): 받은 링크로 열고 다시 공유
    e(5, 5, "ddp", "app_open", kst(D, 18, 0, 0)),
    e(5, 5, "ddp", "share_open", kst(D, 18, 0, 1), { props: { picks: ["1"] } }),
    e(5, 5, "ddp", "share", kst(D, 18, 1, 0), { props: { picks: ["1", "2", "3"] } }),
    // s6 (id 1의 두 번째 세션): 열기만
    e(1, 6, "bongeunsa", "app_open", kst(D, 19, 0, 0)),
  ];
}

describe("R59 하루 지표 (liveDayMetrics)", () => {
  it("R58: 세션 지표 — 사용자·신규·세션·결정·퍼널·다시 뽑기·결정 시간·자동 뽑기 수용·공유 링크·시간대 (거점별, 모든 거점 '*')", async () => {
    await seedEvents(scenario());
    const m = metricMap(await liveDayMetrics(env.DB, D));
    expect({
      users: m["* users"], newUsers: m["* new_users"], sessions: m["* sessions"], decided: m["* decided"],
      funnel: [m["* funnel_draw"], m["* funnel_draw_manual"], m["* funnel_draw_auto_only"], m["* funnel_expand"], m["* funnel_decide"]],
      decision: [m["* funnel_share"], m["* funnel_kakao"], m["* funnel_confirm"]],
      redraws: [m["* redraws_0"], m["* redraws_1"], m["* redraws_2"], m["* redraws_3p"]],
      dt: [m["* dt_lt10"], m["* dt_lt30"], m["* dt_lt300"]],
      auto: [m["* auto_sessions"], m["* auto_accepted"], m["* auto_redrawn"], m["* auto_left"]],
      link: [m["* link_sessions"], m["* reshare_sessions"]],
      hours: [m["* sessions_h12"], m["* sessions_h13"], m["* sessions_h18"], m["* sessions_h19"]],
    }).toEqual({
      users: 5, newUsers: 5, sessions: 6, decided: 3,
      funnel: [4, 2, 2, 2, 2],
      decision: [1, 1, 1],
      redraws: [2, 1, undefined, 1],
      dt: [undefined, 1, 1],
      auto: [3, 1, 1, 1],
      link: [1, 1],
      hours: [2, 2, 1, 1],
    });
    expect([m["bongeunsa users"], m["bongeunsa sessions"], m["ddp users"], m["ddp sessions"]]).toEqual([2, 3, 3, 3]);
    expect([m["bongeunsa decided"], m["ddp decided"], m["ddp auto_left"]]).toEqual([2, 1, 1]);
  });

  it("R58: 자동 뽑기 수용은 첫 뽑기가 자동인 세션만 — 직접 뽑기 뒤 자동 뽑기가 온 세션은 빼고, 첫 자동 뽑기 뒤 직접 뽑기가 있으면 다시 뽑음", async () => {
    const d = "2027-01-13";
    const e = (s: number, type: string, sec: number, props?: object): Seed => ({
      anon: anonN(s), session: sessN(s), hub: "ddp", type, ts: kst(d, 12, 0, sec), ...(props ? { props } : {}),
    });
    await seedEvents([
      // X: 직접 → 자동 → 결정 (자동 뽑기 수용에서 뺀다)
      e(1, "app_open", 0), e(1, "draw", 1, { picks: ["1"] }), e(1, "draw", 2, { picks: ["2"], auto: true }), e(1, "share", 3, { picks: ["2"] }),
      // Y: 자동 → 결정 → 직접 (수용)
      e(2, "app_open", 0), e(2, "draw", 1, { picks: ["1"], auto: true }), e(2, "open_kakao", 2, { rank: 1 }), e(2, "redraw", 3, { picks: ["3"] }),
      // Z: 자동 → 직접 → 결정 (다시 뽑음)
      e(3, "app_open", 0), e(3, "draw", 1, { picks: ["1"], auto: true }), e(3, "redraw", 2, { picks: ["3"] }), e(3, "share", 3, { picks: ["3"] }),
    ]);
    const m = metricMap(await liveDayMetrics(env.DB, d));
    expect([m["* auto_sessions"], m["* auto_accepted"], m["* auto_redrawn"], m["* auto_left"]]).toEqual([2, 1, 1, undefined]);
  });

  it("R58: 이벤트 수 — 직접·자동 뽑기, 완화 섞인 뽑기, 공유(확정 포함)와 확정, 결과 카드 번호별", async () => {
    await seedEvents(scenario());
    const m = metricMap(await liveDayMetrics(env.DB, D));
    expect({
      drawManual: m["* draw_manual"], redraw: m["* redraw"], drawAuto: m["* draw_auto"], relaxed: m["* draw_relaxed"],
      share: m["* share"], confirm: m["* share_confirm"], kakao: m["* open_kakao"], shareOpen: m["* share_open"],
      expand: m["* expand"], exclude: m["* exclude"], filter: m["* filter_change"], empty: m["* empty_result"], events: m["* events"],
      ranks: [m["* expand_r1"], m["* expand_r2"], m["* kakao_r1"], m["* exclude_r3"], m["* confirm_r2"]],
    }).toEqual({
      drawManual: 1, redraw: 4, drawAuto: 3, relaxed: 1, share: 2, confirm: 1, kakao: 1, shareOpen: 1,
      expand: 2, exclude: 1, filter: 2, empty: 1, events: scenario().length,
      ranks: [1, 1, 1, 1, 1],
    });
    expect(m["* app_open"]).toBeUndefined();
    expect([m["bongeunsa draw_auto"], m["ddp draw_auto"], m["ddp redraw"]]).toEqual([1, 2, 1]);
  });

  it("R58: 필터 분포 — filter_change 스냅숏의 인원·종류(없으면 all)·예산·평점·영업 중·반경 구간", async () => {
    await seedEvents(scenario());
    const m = metricMap(await liveDayMetrics(env.DB, D));
    const keys = [
      "f_total", "f_party_2", "f_party_4", "f_group_korean", "f_group_japanese", "f_group_all", "f_price_10000", "f_price_all",
      "f_rating_3.5", "f_rating_0", "f_open_1", "f_open_0", "f_radius_300", "f_radius_1000",
    ];
    expect(Object.fromEntries(keys.map((k) => [k, m[`* ${k}`]]))).toEqual({
      f_total: 2, f_party_2: 1, f_party_4: 1, f_group_korean: 1, f_group_japanese: 1, f_group_all: 1, f_price_10000: 1,
      f_price_all: 1, "f_rating_3.5": 1, f_rating_0: 1, f_open_1: 1, f_open_0: 1, f_radius_300: 1, f_radius_1000: 1,
    });
    expect(m["bongeunsa f_total"]).toBe(2);
    expect(m["ddp f_total"]).toBeUndefined();
  });

  it("R58: 가게 — 직접 뽑기 picks(자동 제외), 공유 picks, 빼줘. 거점·종류마다 그날 상위 20곳만", async () => {
    await seedEvents(scenario());
    const m = metricMap(await liveDayMetrics(env.DB, D));
    expect([m["* pick:1"], m["* pick:7"], m["* pick:4"], m["* pick:12"]]).toEqual([3, 3, 1, undefined]);
    expect([m["* share:1"], m["* share:7"], m["* excl:9"], m["bongeunsa excl:9"]]).toEqual([1, 1, 1, 1]);

    const many: Seed[] = Array.from({ length: 25 }, (_, i) => ({
      anon: anonN(9), session: sessN(9), hub: "pangyo", type: "draw", ts: kst("2027-01-13", 12, 0, i),
      props: { picks: [String(100 + i), "999", "998"] },
    }));
    await seedEvents(many);
    const rows = (await liveDayMetrics(env.DB, "2027-01-13")).filter((r) => r.hub === "*" && r.metric.startsWith("pick:"));
    expect(rows).toHaveLength(20);
    expect(rows.filter((r) => r.value === 25).map((r) => r.metric).sort()).toEqual(["pick:998", "pick:999"]);
  });

  it("R58: KST 날짜 경계 — 23:59:59는 그날, 00:00:00은 다음 날로 센다", async () => {
    await seedEvents([
      { anon: anonN(1), session: sessN(1), hub: "ddp", type: "app_open", ts: kst(D, 23, 59, 59) },
      { anon: anonN(2), session: sessN(2), hub: "ddp", type: "app_open", ts: kst("2027-01-15", 0, 0, 0) },
    ]);
    const a = metricMap(await liveDayMetrics(env.DB, D));
    const b = metricMap(await liveDayMetrics(env.DB, "2027-01-15"));
    expect([a["* sessions"], a["* sessions_h23"], b["* sessions"], b["* sessions_h00"]]).toEqual([1, 1, 1, 1]);
  });

  it("R59: 실시간 집계는 core(세션·이벤트 수)와 detail(필터·가게)로 나눠 셀 수 있고, 둘을 합치면 전체와 같다", async () => {
    await seedEvents(scenario());
    const core = await liveDayMetrics(env.DB, D, "core");
    const detail = await liveDayMetrics(env.DB, D, "detail");
    expect(core.some((r) => r.metric.startsWith("f_") || r.metric.includes(":"))).toBe(false);
    expect(detail.every((r) => r.metric.startsWith("f_") || r.metric.includes(":"))).toBe(true);
    expect([...core, ...detail]).toEqual(await liveDayMetrics(env.DB, D));
  });

  it("R58: 나오는 지표 이름은 모두 정의돼 있다 (shared/dashboard.ts METRICS·METRIC_FAMILIES)", async () => {
    await seedEvents(scenario());
    const rows = await liveDayMetrics(env.DB, D);
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.filter((r) => !isKnownMetric(r.metric)).map((r) => r.metric)).toEqual([]);
    expect(rows.every((r) => r.value > 0 && Number.isInteger(r.value))).toBe(true);
  });
});

describe("R59 Cron 집계 (runRollups)", () => {
  const stats = async (day: string) =>
    (await env.DB.prepare("SELECT hub, metric, value FROM daily_stats WHERE day = ? ORDER BY hub, metric").bind(day).all<{
      hub: string; metric: string; value: number;
    }>()).results;
  const sorted = (rows: { hub: string; metric: string; value: number }[]) =>
    [...rows].sort((a, b) => (a.hub + a.metric < b.hub + b.metric ? -1 : 1));

  it("R59: 전날은 KST 04시 이후 첫 실행에서 집계한다 (그 전에는 그저께까지)", () => {
    expect(lastRollableDay(kst("2027-01-15", 3, 59))).toBe("2027-01-13");
    expect(lastRollableDay(kst("2027-01-15", 4, 0))).toBe("2027-01-14");
    expect(lastRollableDay(kst("2027-01-15", 0, 5))).toBe("2027-01-13");
  });

  it("R59: 집계한 행은 같은 날의 실시간 집계와 같고, 커서(rollup_through)를 올린다. 따라잡은 뒤에는 meta 한 문장만 읽는다", async () => {
    await seedEvents(scenario());
    expect(await runRollups(env.DB, kst("2027-01-15", 4, 5))).toBe(1);
    expect(await rollupThrough(env.DB)).toBe(D);
    // 집계한 뒤에는 그날 첫 방문 기록이 생겼으므로 new_users도 같아야 한다 (첫 방문일 = 그날)
    const live = await liveDayMetrics(env.DB, D);
    expect(sorted(await stats(D))).toEqual(sorted(live));

    const { db, log } = recordingDb(env.DB);
    expect(await runRollups(db, kst("2027-01-15", 4, 10))).toBe(0);
    // 따라잡은 뒤에는 meta 한 문장(커서·실패 기록·오늘 집계 수·오늘 읽기 키)만
    expect(log).toHaveLength(1);
    expect(log[0].read).toBeLessThanOrEqual(8);
  });

  it(`R38/R59: 오늘(UTC) 읽기가 소프트 한도의 ${ROLLUP_BUDGET_SHARE * 100}% 이상이면 집계하지 않는다`, async () => {
    await seedEvents(scenario());
    const now = kst("2027-01-15", 4, 5);
    await env.DB.prepare("INSERT INTO meta VALUES (?, ?)").bind(`d1_read:${utcDay(now)}`, String(900_000)).run();
    expect(await runRollups(env.DB, now, { readSoftCap: 3_000_000 })).toBe(0);
    expect(await rollupThrough(env.DB)).toBeNull();
    expect(await runRollups(env.DB, now, { readSoftCap: 4_000_000 })).toBe(1);
  });

  it(`R59: 밀린 날은 UTC 하루에 ${ROLLUP_MAX_DAYS_PER_UTC_DAY}일까지만 집계하고, 다음 UTC 날에 잇는다`, async () => {
    const days = dayList("2027-01-03", "2027-01-14");
    await seedEvents(days.map((d, i) => ({ anon: anonN(i), session: sessN(i), hub: "ddp", type: "app_open", ts: kst(d, 12) })));
    const now = kst("2027-01-15", 5); // UTC 01-14 20:00
    let total = 0;
    for (let i = 0; i < 6; i++) total += await runRollups(env.DB, now);
    expect(total).toBe(ROLLUP_MAX_DAYS_PER_UTC_DAY);
    expect(await rollupThrough(env.DB)).toBe(days[ROLLUP_MAX_DAYS_PER_UTC_DAY - 1]);
    // 다음 UTC 날(KST 09시 이후)이면 다시 센다
    expect(await runRollups(env.DB, kst("2027-01-15", 9, 5))).toBe(3);
  });

  it("R59: 집계가 실패한 날은 meta에 날짜·시각을 남기고, 한 시간 안에는 다시 하지 않는다", async () => {
    await seedEvents(scenario());
    const now = kst("2027-01-15", 4, 5);
    let calls = 0;
    const failing = new Proxy(env.DB, {
      get(t, k) {
        if (k === "batch") {
          return async () => {
            calls += 1;
            throw new Error("boom");
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    expect(await runRollups(failing, now)).toBe(0);
    expect(calls).toBe(1);
    const failed = await env.DB.prepare("SELECT value FROM meta WHERE key = 'rollup_failed'").first<{ value: string }>();
    expect(JSON.parse(failed!.value)).toEqual({ day: D, at: now, attempts: 1, utc: utcDay(now), utcAttempts: 1 });
    // 실패한 시도도 오늘(UTC) 집계 횟수에 센다 (되돌려진 batch 밖에서)
    expect((await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(`rollup_days:${utcDay(now)}`).first<{ value: string }>())?.value).toBe("1");
    expect(await runRollups(failing, now + 30 * 60_000)).toBe(0);
    expect(calls).toBe(1);
    // 한 시간 뒤에는 다시 하고, 성공하면 실패 기록을 지운다
    expect(await runRollups(env.DB, now + 61 * 60_000)).toBe(1);
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key = 'rollup_failed'").first()).toBeNull();
  });

  it("R59: 실패가 되풀이되면 1→2→4시간… 간격(최대 24시간)으로 늦추고, UTC 하루에 3번 실패하면 그날은 더 하지 않는다", async () => {
    await seedEvents(scenario());
    const t0 = kst("2027-01-15", 9, 30); // UTC 01-15 00:30
    const H = 3600_000;
    let calls = 0;
    const failing = new Proxy(env.DB, {
      get(t, k) {
        if (k === "batch") {
          return async () => {
            calls += 1;
            throw new Error("boom");
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    for (const at of [t0, t0 + 0.5 * H, t0 + 1 * H, t0 + 2.5 * H, t0 + 3 * H, t0 + 6 * H, t0 + 7 * H, t0 + 20 * H]) {
      await runRollups(failing, at);
    }
    // t0, t0+1h(1시간 뒤), t0+3h(2시간 뒤)에만 시도하고, 세 번 실패한 뒤로는 같은 UTC 날(t0+7h, t0+20h)에는 시도하지 않는다
    expect(calls).toBe(3);
    const failed = JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'rollup_failed'").first<{ value: string }>())!.value);
    expect(failed).toEqual({ day: D, at: t0 + 3 * H, attempts: 3, utc: utcDay(t0), utcAttempts: 3 });
    // 다음 UTC 날에는 (마지막 실패 + 4시간이 지났으면) 다시 한다
    await runRollups(failing, t0 + 24 * H);
    expect(calls).toBe(4);
    expect(JSON.parse((await env.DB.prepare("SELECT value FROM meta WHERE key = 'rollup_failed'").first<{ value: string }>())!.value))
      .toMatchObject({ attempts: 4, utcAttempts: 1 });
    expect(rollupRetryMs(1)).toBe(H);
    expect(rollupRetryMs(5)).toBe(16 * H);
    expect(rollupRetryMs(9)).toBe(24 * H);
  });

  it(`R59: 밀린 날은 오래된 날부터 실행마다 ${ROLLUP_DAYS_PER_RUN}일까지만, 처음이면 가장 오래된 이벤트 날부터`, async () => {
    const days = ["2027-01-08", "2027-01-09", "2027-01-10", "2027-01-11", "2027-01-12", "2027-01-13", "2027-01-14"];
    await seedEvents(days.map((d, i) => ({ anon: anonN(i), session: sessN(i), hub: "ddp", type: "app_open", ts: kst(d, 12) })));
    const now = kst("2027-01-15", 5);
    expect(await runRollups(env.DB, now)).toBe(3);
    expect(await rollupThrough(env.DB)).toBe("2027-01-10");
    expect(await runRollups(env.DB, now)).toBe(3);
    expect(await runRollups(env.DB, now)).toBe(1);
    expect(await rollupThrough(env.DB)).toBe("2027-01-14");
    expect((await stats("2027-01-14")).find((r) => r.hub === "*" && r.metric === "sessions")?.value).toBe(1);
  });

  it("R59: 이벤트가 하나도 없으면 커서만 두고 아무것도 쓰지 않는다", async () => {
    expect(await runRollups(env.DB, kst("2027-01-15", 5))).toBe(0);
    expect(await rollupThrough(env.DB)).toBe("2027-01-14");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM daily_stats").first<{ n: number }>())?.n).toBe(0);
  });

  it("R59: 같은 날을 다시 집계해도 결과가 같다 (지우고 다시 쓴다, 코호트 행은 지우지 않는다)", async () => {
    await seedEvents(scenario());
    await env.DB.batch(rollupDayStatements(env.DB, D));
    const first = await stats(D);
    await env.DB.prepare("INSERT INTO daily_stats VALUES (?, '*', 'cohort_size', 7)").bind(D).run();
    await env.DB.batch(rollupDayStatements(env.DB, D));
    expect(await stats(D)).toEqual(sorted([...first, { hub: "*", metric: "cohort_size", value: 7 }]));
  });

  it("R58/R59: 재방문 코호트 — 첫 방문 주(월요일)별 크기와 D1·D7·D14·D28(첫 방문일 + n일 이후 다시 엶), 이전에 온 id는 신규가 아님", async () => {
    const open = (n: number, day: string, hub = "bongeunsa"): Seed => ({
      anon: anonN(n), session: `${sessN(n).slice(0, 30)}${day.replaceAll("-", "").slice(2)}`, hub, type: "app_open", ts: kst(day, 12),
    });
    await seedEvents([
      open(1, "2026-12-28"), open(1, "2026-12-29"), open(1, "2027-01-04"), // D1, D7
      open(2, "2026-12-30", "ddp"), // 다시 오지 않음
      open(3, "2026-12-31"), open(3, "2027-01-28"), // 28일 뒤 → D1·D7·D14·D28 모두
      open(4, "2027-01-05"), // 다음 주 코호트
    ]);
    const now = kst("2027-01-30", 5);
    for (let i = 0; i < 20 && (await runRollups(env.DB, now, { maxDaysPerUtcDay: 100 })) > 0; i++);
    expect(await rollupThrough(env.DB)).toBe("2027-01-29");
    const seen = (await env.DB.prepare("SELECT anon, day, hub, ret, last_day FROM anon_first_seen ORDER BY anon").all()).results;
    expect(seen).toEqual([
      { anon: anonN(1), day: "2026-12-28", hub: "bongeunsa", ret: 3, last_day: "2027-01-04" },
      { anon: anonN(2), day: "2026-12-30", hub: "ddp", ret: 0, last_day: "2026-12-30" },
      { anon: anonN(3), day: "2026-12-31", hub: "bongeunsa", ret: 15, last_day: "2027-01-28" },
      { anon: anonN(4), day: "2027-01-05", hub: "bongeunsa", ret: 0, last_day: "2027-01-05" },
    ]);
    const cohort = Object.fromEntries(
      (await stats("2026-12-28")).filter((r) => r.hub === "*").map((r) => [r.metric, r.value]),
    );
    expect(cohort).toMatchObject({ cohort_size: 3, cohort_d1: 2, cohort_d7: 2, cohort_d14: 1, cohort_d28: 1 });
    expect((await stats("2026-12-28")).find((r) => r.hub === "ddp" && r.metric === "cohort_size")?.value).toBe(1);
    expect((await stats("2027-01-04")).find((r) => r.hub === "*" && r.metric === "cohort_size")?.value).toBe(1);
    // 12/29의 id 1은 재방문이라 신규가 아니다
    const d29 = Object.fromEntries((await stats("2026-12-29")).filter((r) => r.hub === "*").map((r) => [r.metric, r.value]));
    expect([d29.users, d29.new_users]).toEqual([1, undefined]);
  });

  it("R58/R59: 코호트는 첫 방문 기록이 모두 남아 있는 주(월요일 ≥ 오늘 − 90일)만 다시 세고, 그보다 오래된 주는 마지막 값 그대로 둔다 (정리로 줄어들지 않게)", async () => {
    const now = kst("2027-06-01", 4, 1); // 90일 전 = 2027-03-03(수) → 다시 세는 첫 주 = 03-08
    await env.DB.batch([
      env.DB.prepare("INSERT INTO daily_stats VALUES ('2027-03-01', '*', 'cohort_size', 5), ('2027-03-01', '*', 'cohort_d1', 2)"),
      // 03-01 주의 id(마지막 방문 03-02)는 정리에서 지워진다
      env.DB.prepare("INSERT INTO anon_first_seen VALUES (?, '2027-03-02', 'ddp', 1, '2027-03-02')").bind(anonN(1)),
      env.DB.prepare("INSERT INTO anon_first_seen VALUES (?, '2027-03-09', 'ddp', 1, '2027-03-10')").bind(anonN(2)),
    ]);
    await pruneRollups(env.DB, now);
    await env.DB.batch(cohortStatements(env.DB, kstDay(now)));
    const rows = (await env.DB.prepare("SELECT day, metric, value FROM daily_stats WHERE hub = '*' ORDER BY day, metric").all()).results;
    expect(rows).toEqual([
      { day: "2027-03-01", metric: "cohort_d1", value: 2 },
      { day: "2027-03-01", metric: "cohort_size", value: 5 },
      { day: "2027-03-08", metric: "cohort_d1", value: 1 },
      { day: "2027-03-08", metric: "cohort_size", value: 1 },
    ]);
  });

  it("R35/R59: 보관 정리 — 90일 넘게 오지 않은 id의 첫 방문 기록과 400일 지난 집계를 지운다", async () => {
    const now = kst("2027-06-01", 4, 1);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO anon_first_seen VALUES (?, '2027-01-01', 'ddp', 0, '2027-03-02')").bind(anonN(1)),
      env.DB.prepare("INSERT INTO anon_first_seen VALUES (?, '2027-01-01', 'ddp', 1, '2027-03-03')").bind(anonN(2)),
      env.DB.prepare("INSERT INTO daily_stats VALUES ('2026-04-26', '*', 'sessions', 1), ('2026-04-27', '*', 'sessions', 1)"),
      env.DB.prepare("INSERT INTO meta VALUES ('rollup_days:2027-05-30', '7'), ('rollup_days:2027-05-31', '2'), ('rollup_through', '2027-05-30')"),
    ]);
    await pruneRollups(env.DB, now);
    expect((await env.DB.prepare("SELECT anon FROM anon_first_seen").all()).results).toEqual([{ anon: anonN(2) }]);
    expect((await env.DB.prepare("SELECT day FROM daily_stats").all()).results).toEqual([{ day: "2026-04-27" }]);
    // 지난 UTC 날의 집계 횟수만 지운다 (오늘 UTC = 05-31)
    expect((await env.DB.prepare("SELECT key FROM meta ORDER BY key").all()).results).toEqual([
      { key: "rollup_days:2027-05-31" }, { key: "rollup_through" },
    ]);
  });
});

describe("R59 Cron 통합 (runScheduled)", () => {
  const fetcher = routeFetch(fakeKakaoLocal([]).fetcher, fakePlaceApi({}).fetcher);
  const lastRun = async () => {
    const r = await env.DB.prepare("SELECT value FROM meta WHERE key = 'cron_last'").first<{ value: string }>();
    return r ? (JSON.parse(r.value) as Record<string, unknown>) : null;
  };

  it("R59: 실행마다 밀린 집계를 하고, 마지막 실행 요약(meta cron_last)을 사용량 기록과 같은 UPSERT 한 문장으로 남긴다", async () => {
    await seedEvents(scenario());
    const now = kst("2027-01-15", 4, 5);
    const { db, log } = recordingDb(env.DB);
    const r = await runScheduled({ ...env, DB: db }, { fetcher, now, sleep: async () => {}, hubs: [] });
    expect(r.rolled).toBe(1);
    expect(await rollupThrough(env.DB)).toBe(D);
    expect(await lastRun()).toEqual({ at: now, collected: 0, incomplete: 0, enriched: 0, failed: 0, calls: 0, rolled: 1 });
    const record = log.filter((x) => x.sql.includes("cron_last"));
    expect(record).toHaveLength(1);
    expect(record[0].sql).toContain("INSERT INTO meta");
  });

  it("R38/R59: 읽기 예산을 넘은 날은 집계도 건너뛰고, 요약에 skipped를 남긴다", async () => {
    await seedEvents(scenario());
    const now = kst("2027-01-15", 4, 5);
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, '3000001')").bind(`d1_read:${utcDay(now)}`).run();
    const r = await runScheduled(env, { fetcher, now, sleep: async () => {}, hubs: [] });
    expect(r.rolled ?? 0).toBe(0);
    expect(await rollupThrough(env.DB)).toBeNull();
    expect(await lastRun()).toMatchObject({ at: now, skipped: "read_budget", rolled: 0 });
  });

  it("R35/R59: 보관 정리 창(KST 04:00~04:04)에서 첫 방문 기록·오래된 집계도 정리한다", async () => {
    const now = kst("2027-06-01", 4, 1);
    await env.DB.prepare("INSERT INTO anon_first_seen VALUES (?, '2027-01-01', 'ddp', 0, '2027-01-02')").bind(anonN(1)).run();
    await runScheduled(env, { fetcher, now, sleep: async () => {}, hubs: [] });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM anon_first_seen").first<{ n: number }>())?.n).toBe(0);
  });
});
