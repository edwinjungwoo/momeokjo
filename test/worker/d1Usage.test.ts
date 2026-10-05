import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASEM, PREWARM_RADIUS } from "../../shared/constants";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { HUBS } from "../../shared/hubs";
import { kstDay } from "../../shared/kst";
import { createApp } from "../../worker/app";
import {
  d1UsageOn, meteredDb, readSoftCap, recordD1Usage, type D1Usage,
} from "../../worker/d1Usage";
import { runScheduled } from "../../worker/maintenance";
import { markTile, replaceTilePlaces } from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { doc, fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { placeJson } from "../helpers/places";

const NOW = 1_800_000_000_000; // 2027-01-15 17:00 KST
const TODAY = "2027-01-15";
const AUTH = { Authorization: "Bearer test-admin-token" };
const AREA = `lat=${ASEM.lat}&lng=${ASEM.lng}&radius=300`;
const at = (dLat: number) => ASEM.lat + dLat;

const fresh = (): D1Usage => ({ read: 0, written: 0 });
const setUsage = (day: string, read: number, written = 0) =>
  env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(`d1_read:${day}`, String(read)),
    env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(`d1_written:${day}`, String(written)),
  ]);

function setup(n = 2) {
  const ids = Array.from({ length: n }, (_, i) => String(1001 + i));
  const local = fakeKakaoLocal(ids.map((id, i) => doc(id, at(0.0001 * (i + 1)), ASEM.lng)));
  const place = fakePlaceApi(
    Object.fromEntries(ids.map((id, i) => [id, placeJson({ name: `가게${id}`, lat: at(0.0001 * (i + 1)), lng: ASEM.lng })])),
  );
  const fetcher = routeFetch(local.fetcher, place.fetcher);
  const app = createApp({ fetcher, now: () => NOW, sleep: async () => {}, rateLimit: async () => true });
  return { app, local, place, fetcher };
}

describe("D1 읽기 예산", () => {
  it("R38: KST 날짜는 UTC+9 기준으로 바뀐다", () => {
    expect(kstDay(NOW)).toBe(TODAY);
    expect(kstDay(Date.UTC(2027, 0, 14, 14, 59, 59, 999))).toBe("2027-01-14");
    expect(kstDay(Date.UTC(2027, 0, 14, 15, 0, 0, 0))).toBe("2027-01-15");
  });

  it("R38: 계측 DB는 all·run·first·batch의 rows_read/rows_written을 모은다", async () => {
    const usage = fresh();
    const db = meteredDb(env.DB, usage);
    await db.prepare("INSERT INTO tiles (key, collected_at, place_count) VALUES ('a', 1, 0)").run();
    expect(usage.written).toBeGreaterThan(0);
    const w = usage.written;
    await db.batch([
      db.prepare("INSERT INTO tiles (key, collected_at, place_count) VALUES (?, 1, 0)").bind("b"),
      db.prepare("INSERT INTO tiles (key, collected_at, place_count) VALUES (?, 1, 0)").bind("c"),
    ]);
    expect(usage.written).toBeGreaterThan(w);
    const r0 = usage.read;
    const all = await db.prepare("SELECT key FROM tiles ORDER BY key").all<{ key: string }>();
    expect(all.results.map((x) => x.key)).toEqual(["a", "b", "c"]);
    expect(usage.read).toBeGreaterThanOrEqual(r0 + 3);
    const r1 = usage.read;
    expect(await db.prepare("SELECT key FROM tiles WHERE key = ?").bind("b").first<{ key: string }>()).toEqual({ key: "b" });
    expect(await db.prepare("SELECT key FROM tiles WHERE key = ?").bind("b").first("key")).toBe("b");
    expect(await db.prepare("SELECT key FROM tiles WHERE key = 'zz'").first()).toBeNull();
    expect(usage.read).toBeGreaterThan(r1);
  });

  it("R38: 실행이 끝날 때 오늘(KST) 읽기·쓰기 행 수를 한 번에 더해 기록한다", async () => {
    await recordD1Usage(env.DB, { read: 120, written: 7 }, NOW);
    await recordD1Usage(env.DB, { read: 30, written: 0 }, NOW);
    expect(await d1UsageOn(env.DB, TODAY)).toEqual({ read: 150, written: 7 });
    expect(await d1UsageOn(env.DB, "2027-01-14")).toEqual({ read: 0, written: 0 });
  });

  it("R38: 소프트 한도는 D1_READ_SOFT_CAP, 없거나 잘못되면 3,000,000", () => {
    expect(readSoftCap({ D1_READ_SOFT_CAP: "1000" } as unknown as Env)).toBe(1000);
    expect(readSoftCap({ D1_READ_SOFT_CAP: "x" } as unknown as Env)).toBe(3_000_000);
    expect(readSoftCap({} as unknown as Env)).toBe(3_000_000);
  });

  it("R38: 오늘 읽기가 소프트 한도를 넘으면 warm은 외부 호출·수집 없이 429 read_budget", async () => {
    await setUsage(TODAY, 3_000_000);
    const { app, local, place } = setup();
    const res = await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "read_budget" });
    expect(local.calls).toHaveLength(0);
    expect(place.calls).toHaveLength(0);
  });

  it("R38: 어제 사용량은 오늘 한도에 들어가지 않는다", async () => {
    await setUsage("2027-01-14", 4_000_000);
    const { app } = setup();
    expect((await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: AUTH })).status).toBe(200);
  });

  it("R38: warm·places 요청은 쓴 D1 행 수를 오늘 사용량에 더한다", async () => {
    const { app } = setup();
    await callApp(app, `/api/admin/warm?${AREA}`, { method: "POST", headers: AUTH });
    const a = await d1UsageOn(env.DB, TODAY);
    expect(a.read).toBeGreaterThan(0);
    expect(a.written).toBeGreaterThan(0);
    await callApp(app, "/api/places?hub=bongeunsa&radius=300");
    const b = await d1UsageOn(env.DB, TODAY);
    expect(b.read).toBeGreaterThan(a.read);
  });

  it("R31: warm의 pending은 전체 스캔 없이 이번 선택으로 판단한다 (배치를 다 채우면 more, 덜 채우면 0)", async () => {
    const { app } = setup(12);
    const warm = async (q = "") =>
      (await callApp(app, `/api/admin/warm?${AREA}${q}`, { method: "POST", headers: AUTH })).json<any>();
    expect(await warm()).toEqual({ incompleteTiles: 0, pending: "more", enriched: 10, failed: 0 });
    expect(await warm()).toEqual({ incompleteTiles: 0, pending: 0, enriched: 2, failed: 0 });
  });

  it("R31: ?count=1이면 남은 수를 정확히 센다", async () => {
    const { app } = setup(12);
    const r = await (await callApp(app, `/api/admin/warm?${AREA}&count=1`, { method: "POST", headers: AUTH })).json<any>();
    expect(r).toEqual({ incompleteTiles: 0, pending: 2, enriched: 10, failed: 0 });
  });

  it("R31: 예산이 바닥나 상세를 못 고르면 pending은 more다 (끝났다고 보고하지 않는다)", async () => {
    await replaceTilePlaces(env.DB, tileKeyOf(ASEM), ["1001"], NOW, false);
    const { fetcher } = setup(1);
    const app = createApp({ fetcher, now: () => NOW, sleep: async () => {}, rateLimit: async () => true });
    // 격자 수집이 예산(40)을 다 쓰게 반경을 넓힌다
    const r = await (
      await callApp(app, `/api/admin/warm?lat=${ASEM.lat}&lng=${ASEM.lng}&radius=1000`, { method: "POST", headers: AUTH })
    ).json<any>();
    expect(r.incompleteTiles).toBeGreaterThan(0);
    expect(r.pending).toBe("more");
  });

  it("R38: 소프트 한도를 넘은 날 Cron은 수집·보충을 건너뛰고 외부 호출을 하지 않는다", async () => {
    await setUsage(TODAY, 3_000_001);
    const { fetcher, local, place } = setup();
    const r = await runScheduled(env, { fetcher, now: NOW, sleep: async () => {} });
    expect(r.skipped).toBe("read_budget");
    expect(r.tiles.collected).toBe(0);
    expect(local.calls).toHaveLength(0);
    expect(place.calls).toHaveLength(0);
  });

  it("R38: Cron도 쓴 D1 행 수를 오늘 사용량에 한 번 더한다", async () => {
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    const before = await d1UsageOn(env.DB, TODAY);
    await runScheduled(env, { fetcher: setup().fetcher, now: NOW, sleep: async () => {} });
    const after = await d1UsageOn(env.DB, TODAY);
    expect(after.read).toBeGreaterThan(before.read);
  });
});
