import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PREWARM_RADIUS } from "../../shared/constants";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { HUBS, hubById } from "../../shared/hubs";
import { utcDay } from "../../shared/kst";
import { CRON_DETAIL_LAST_KEY } from "../../worker/d1Usage";
import { hubRefreshStart } from "../../worker/refreshSchedule";
import {
  CRON_D1_CALL_LIMIT, MAIN_CRON, SECOND_CRON, runCron, runDetailCron, runScheduled, secondCronJob,
} from "../../worker/maintenance";
import { getMeta, placeById, replaceTilePlaces } from "../../worker/repo";
import { doc, fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { placeJson } from "../helpers/places";
import wranglerConfig from "../../wrangler.jsonc?raw";

/** 2026-10-07 수요일 10:00 KST = 01:00 UTC — 분 단위는 아래에서 고른다 */
const BASE = Date.UTC(2026, 9, 7, 1, 0);
const at = (minute: number) => BASE + minute * 60_000;
const BONG = hubById("bongeunsa");
const S_BONG = hubRefreshStart(BONG, BASE);
const KB = tileKeyOf(BONG);
const ALL_KEYS = [...new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)))];

async function markFresh(keys: string[], t: number) {
  for (let i = 0; i < keys.length; i += 200) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO tiles (key, collected_at, place_count, saturated) SELECT value, ?, 0, 0 FROM json_each(?)",
    ).bind(t, JSON.stringify(keys.slice(i, i + 200))).run();
  }
}
async function seedOk(rows: [string, number][]) {
  await env.DB.prepare(
    `INSERT INTO places (id, status, name, category_name, category_group, lat, lng, fetched_at)
     SELECT json_extract(value, '$[0]'), 'ok', '가게', '음식점 > 한식', 'korean', ?, ?, json_extract(value, '$[1]') FROM json_each(?)`,
  ).bind(BONG.lat, BONG.lng, JSON.stringify(rows)).run();
}
const json = (name: string) => placeJson({ name, lat: BONG.lat, lng: BONG.lng });
const metaValue = async (key: string) =>
  (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;

describe("R63 둘째 트리거 (홀수 분) — 스냅샷·쉼·상세만 보충", () => {
  it("R63/R56: 둘째 트리거는 1-59/2(홀수 분)이고 UTC 분으로 나눈다 — 7·17·…·57은 스냅샷, 5의 배수는 쉼(본 Cron 분), 나머지는 상세만", () => {
    expect(SECOND_CRON).toBe("1-59/2 * * * *");
    expect(wranglerConfig).toContain(`"${MAIN_CRON}"`);
    expect(wranglerConfig).toContain(`"${SECOND_CRON}"`);
    // 트리거는 두 개 그대로 (계정의 Cron 트리거 수를 늘리지 않는다), 예전 2-59/5는 없다
    expect(wranglerConfig).toMatch(/"crons": \["\*\/5 \* \* \* \*", "1-59\/2 \* \* \* \*"\]/);
    const jobs = new Map<string, number[]>();
    for (let m = 1; m < 60; m += 2) {
      const j = secondCronJob(at(m));
      jobs.set(j, [...(jobs.get(j) ?? []), m]);
    }
    expect(jobs.get("snapshot")).toEqual([7, 17, 27, 37, 47, 57]);
    expect(jobs.get("skip")).toEqual([5, 15, 25, 35, 45, 55]);
    expect(jobs.get("detail")).toHaveLength(18);
    // 본 Cron 분(5의 배수)과 상세만 실행은 같은 분을 쓰지 않는다
    for (const m of jobs.get("detail")!) expect(m % 5, String(m)).not.toBe(0);
  });

  it("R63: runCron은 둘째 트리거를 예정 시각의 분으로 나누고, 본 Cron·모르는 문자열은 그대로 본 Cron이다", async () => {
    await markFresh(ALL_KEYS, BASE);
    const opts = { fetcher: fakePlaceApi({}).fetcher, sleep: async () => {} };
    expect((await runCron(SECOND_CRON, env, { ...opts, now: at(7), scheduledTime: at(7) })).cron).toBe("snapshot");
    expect(await runCron(SECOND_CRON, env, { ...opts, now: at(15), scheduledTime: at(15) })).toEqual({ cron: "idle" });
    expect((await runCron(SECOND_CRON, env, { ...opts, now: at(3) + 2000, scheduledTime: at(3) })).cron).toBe("detail");
    expect((await runCron(MAIN_CRON, env, { ...opts, now: at(10) })).cron).toBe("maintain");
    expect((await runCron("* * * * *", env, { ...opts, now: at(20) })).cron).toBe("maintain");
  });

  it("R63/R38: 상세만 실행은 만료·미수집 후보를 보충하고 사용량과 cron_detail_last를 남긴다 — 격자 수집·집계·스냅샷·완료 기록은 하지 않는다", async () => {
    // 봉은사 격자는 시작 전에 수집해서 수집 대상이지만 상세만 실행은 모으지 않는다
    await markFresh(ALL_KEYS, BASE);
    await markFresh(tilesCoveringCircle(BONG, PREWARM_RADIUS), S_BONG - 1);
    await seedOk([["old1", S_BONG - 1], ["old2", S_BONG - 2]]);
    await replaceTilePlaces(env.DB, KB, ["old1", "old2", "new1"], S_BONG - 1, false);
    const local = fakeKakaoLocal([doc("zzz", BONG.lat, BONG.lng)]);
    const place = fakePlaceApi({ old1: json("o1"), old2: json("o2"), new1: json("n1") });
    const r = await runDetailCron(env, { fetcher: routeFetch(local.fetcher, place.fetcher), now: at(3), sleep: async () => {} });
    expect(local.calls).toHaveLength(0);
    expect(place.calls.map((c) => c.id)).toEqual(["new1", "old1", "old2"]); // 미수집 먼저
    expect(r).toMatchObject({ enriched: 3, failed: 0, batch: 4 });
    expect(r.d1Calls).toBeLessThanOrEqual(CRON_D1_CALL_LIMIT - 1);
    expect((await getMeta(env.DB, "old1"))?.fetchedAt).toBe(at(3));
    expect(await env.DB.prepare("SELECT count(*) AS n FROM hub_snapshots").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await metaValue("rollup_through")).toBeNull();
    expect(await metaValue("hub_refreshed:bongeunsa")).toBeNull();
    expect(JSON.parse((await metaValue(CRON_DETAIL_LAST_KEY))!)).toMatchObject({ at: at(3), enriched: 3, failed: 0, calls: 3 });
    expect(Number(await metaValue(`d1_read:${utcDay(at(3))}`))).toBeGreaterThan(0);
    expect(await metaValue("cron_last")).toBeNull();
  });

  it("R38/R44/R52: 상세만 실행은 읽기 예산을 넘었거나 쿨다운·frozen이면 상세를 부르지 않고, 읽기 전용(개발 서버)이면 아무것도 하지 않는다", async () => {
    await markFresh(ALL_KEYS, BASE);
    await seedOk([["old1", S_BONG - 1]]);
    await replaceTilePlaces(env.DB, KB, ["old1"], BASE, false);
    const place = fakePlaceApi({ old1: json("o1") });
    const run = (e: Env, now: number) => runDetailCron(e, { fetcher: place.fetcher, now, sleep: async () => {} });

    const ro = await run({ ...env, READ_ONLY: "1" } as unknown as Env, at(1));
    expect(ro).toMatchObject({ skipped: "read_only" });
    expect(await metaValue(CRON_DETAIL_LAST_KEY)).toBeNull();

    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('place_blocked_until', ?)").bind(String(at(60))).run();
    expect(await run(env, at(3))).toMatchObject({ enriched: 0, skipped: "paused" });
    await env.DB.prepare("DELETE FROM meta WHERE key = 'place_blocked_until'").run();
    // R44 강등 모드(detail_mode frozen)도 같다
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('detail_mode', ?)")
      .bind(JSON.stringify({ mode: "frozen", since: at(0), until: at(0) + 24 * 3600_000 })).run();
    expect(await run(env, at(4))).toMatchObject({ enriched: 0, skipped: "paused" });
    expect(JSON.parse((await metaValue(CRON_DETAIL_LAST_KEY))!)).toMatchObject({ at: at(4), skipped: "paused" });
    await env.DB.prepare("DELETE FROM meta WHERE key = 'detail_mode'").run();

    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '99999999')").bind(`d1_read:${utcDay(at(9))}`).run();
    expect(await run(env, at(9))).toMatchObject({ enriched: 0, skipped: "read_budget" });
    expect(place.calls).toHaveLength(0);
    expect(JSON.parse((await metaValue(CRON_DETAIL_LAST_KEY))!)).toMatchObject({ skipped: "read_budget" });
  });

  it("R63/R38: 상세만 실행이 던지는 오류로 끝나도 사용량과 cron_detail_last(skipped: error)는 남긴다 — 본 Cron과 같다", async () => {
    await markFresh(ALL_KEYS, BASE);
    const broken = { ...env, DETAIL_BATCH_SIZE: "4" } as unknown as Env;
    const db = env.DB;
    // 쿨다운 읽기(detail_mode·place_blocked_until)에서 던지는 D1
    const throwing = new Proxy(db, {
      get(t, k) {
        if (k !== "prepare") return Reflect.get(t, k);
        return (sql: string) => {
          if (sql.includes("place_blocked_until") || /key IN \(\?, \?\)/.test(sql) && sql.includes("SELECT key, value FROM meta")) {
            throw new Error("boom");
          }
          return t.prepare(sql);
        };
      },
    }) as D1Database;
    await expect(runDetailCron({ ...broken, DB: throwing }, { fetcher: fakePlaceApi({}).fetcher, now: at(11) })).rejects.toThrow("boom");
    expect(JSON.parse((await metaValue(CRON_DETAIL_LAST_KEY))!)).toMatchObject({ at: at(11), skipped: "error" });
  });

  it("R63: 오래 걸린 실행이 겹쳐 본 Cron과 상세만 실행이 같은 후보를 동시에 골라도 저장은 망가지지 않는다 (같은 상세를 두 번 쓸 뿐) — 이어지는 실행이 남은 것을 마저 한다", async () => {
    await markFresh(ALL_KEYS, BASE);
    const ids = Array.from({ length: 10 }, (_, i) => `p${i}`);
    await seedOk(ids.map((id, i) => [id, S_BONG - 1 - i]));
    await replaceTilePlaces(env.DB, KB, ids, BASE, false);
    const place = fakePlaceApi(Object.fromEntries(ids.map((id) => [id, json(`가게${id}`)])));
    const opts = { fetcher: place.fetcher, sleep: async () => {}, hubs: [BONG] };
    const [main, detail] = await Promise.all([
      runScheduled(env, { ...opts, now: at(10) }),
      runDetailCron(env, { ...opts, now: at(10) + 30_000 }),
    ]);
    expect(main.enrichError).toBeUndefined();
    expect(detail.enrichError).toBeUndefined();
    for (const id of ids.filter((id) => place.calls.some((c) => c.id === id))) {
      const row = await placeById(env.DB, id);
      expect(row?.place.name, id).toBe(`가게${id}`);
      expect(row?.meta.status).toBe("ok");
    }
    // 커서 값은 읽을 수 있는 모양으로 남는다
    for (const k of ["expired_from:ok", "expired_from:failed"]) {
      const v = await metaValue(k);
      if (v !== null) expect(JSON.parse(v)).toMatchObject({ from: expect.any(Number), rid: expect.any(Number) });
    }
    // 이어지는 실행들이 남은 것을 마저 하고, 완료가 기록된다
    for (let m = 13; m < 60 && (await metaValue("hub_refreshed:bongeunsa")) === null; m += 2) {
      if (m % 5 === 0) await runScheduled(env, { ...opts, now: at(m) });
      else await runDetailCron(env, { ...opts, now: at(m) });
      if (m % 10 === 9) await runScheduled(env, { ...opts, now: at(m + 1) });
    }
    for (const id of ids) expect((await getMeta(env.DB, id))?.fetchedAt, id).toBeGreaterThanOrEqual(at(10));
    expect(JSON.parse((await metaValue("hub_refreshed:bongeunsa"))!)).toMatchObject({ start: S_BONG });
  });
});
