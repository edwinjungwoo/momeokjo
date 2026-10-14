import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tileKeyOf } from "../../shared/geo";
import { isPublicHubId } from "../../shared/hubs";
import { auditArea, auditPass } from "../../worker/audit";
import { recordD1Usage, readSoftCap } from "../../worker/d1Usage";
import {
  PUBLISH_CHECK_D1_CALLS, PUBLISH_CHECK_INTERVAL_MS, PUBLISH_COVERAGE_RETRY_MS, pickPublishCheck, runPublishCheck,
} from "../../worker/hubPublish";
import { hubTiles } from "../../worker/hubTiles";
import { runScheduled } from "../../worker/maintenance";
import {
  HUB_PUBLIC_CHECK_PREFIX, HUB_PUBLIC_PREFIX, parsePublishCheck, parsePublishRecord, resetPublicHubsCache,
} from "../../worker/publicHubs";
import { markTile, replaceTilePlaces, saveDetailFailure } from "../../worker/repo";
import { fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { seedPlace } from "../helpers/places";
import { countingDb } from "../helpers/recordDb";
import { UNREADY_HUB } from "../helpers/unreadyHub";

// R68: 공개 후보 동작은 테스트 전용 준비 중 거점으로 본다 — HUBS에 더한다
vi.mock("../../shared/hubs", async (orig) => (await import("../helpers/unreadyHub")).withUnreadyHub(orig));

const NOW = 1_800_000_000_000;
const H = UNREADY_HUB;
const ID = H.id;
const CENTER = tileKeyOf(H);
const IDS = Array.from({ length: 20 }, (_, i) => String(9000 + i));

/** 후보 격자를 모두 모으고(포화 없음) 가운데 칸에 20곳, 모두 상세 ok — 감사 통과 */
async function seedPassing(opts: { saturatedKey?: string; skipKey?: string } = {}) {
  for (const k of hubTiles(H)) if (k !== opts.skipKey) await markTile(env.DB, k, NOW, 0, k === opts.saturatedKey);
  await replaceTilePlaces(env.DB, CENTER, IDS, NOW, false);
  for (const id of IDS) await seedPlace(env.DB, id, H.lat, H.lng, { now: NOW });
}
const meta = async (key: string) =>
  (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>())?.value;
const record = async () => parsePublishRecord(await meta(HUB_PUBLIC_PREFIX + ID));
const check = async () => parsePublishCheck(await meta(HUB_PUBLIC_CHECK_PREFIX + ID));
const metaOf = (o: Record<string, unknown>) => new Map(Object.entries(o).map(([k, v]) => [k, JSON.stringify(v)] as const));

beforeEach(() => resetPublicHubsCache());
afterEach(() => resetPublicHubsCache());

describe("R68 감사 통과 판단 (auditPass)", () => {
  it("R68: auditPass는 auditArea와 같은 격자·상세 숫자와 Q1·Q2를 낸다 — 장소 행을 읽지 않는 집계 질의 3번 안", async () => {
    await seedPassing({ saturatedKey: hubTiles(H)[0] });
    await replaceTilePlaces(env.DB, hubTiles(H)[1], ["8001", "8002", IDS[0]], NOW, false);
    await saveDetailFailure(env.DB, "8001", "http_500", NOW);
    const full = await auditArea(env.DB, H, 1000);
    const c = countingDb(env.DB);
    const p = await auditPass(c.db, H);
    expect(c.calls()).toBeLessThanOrEqual(3);
    expect(p.tiles).toEqual(full.tiles);
    expect(p.detail).toEqual(full.detail);
    expect(p.pass).toEqual(full.pass);
    expect(p.places).toBe(full.places);
  });
});

describe("R68 본 Cron 공개 확인", () => {
  it("R68: 모든 조건을 통과하면 공개 기록(by auto, 감사 숫자)과 확인 결과를 쓰고, 이 격리 공간에 바로 공개 — 'hub published {id}' 로그", async () => {
    await seedPassing();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const c = countingDb(env.DB);
    const r = await runPublishCheck(c.db, H, NOW);
    expect(c.calls()).toBeLessThanOrEqual(PUBLISH_CHECK_D1_CALLS);
    expect(r).toMatchObject({ at: NOW, pass: true, reason: null });
    expect(await record()).toMatchObject({ state: "public", by: "auto", at: NOW, audit: { places: 20, ok: 20, missing: 0, coverage: 1, saturated: 0 } });
    expect(await check()).toMatchObject({ at: NOW, pass: true });
    expect(isPublicHubId(ID)).toBe(true);
    expect(log).toHaveBeenCalledWith(`hub published ${ID}`);
    log.mockRestore();
  });

  it.each([
    ["tiles", { skipKey: "first" }],
    ["saturated", { saturatedKey: "first" }],
  ] as const)("R68: 격자 조건(%s)에서 막히면 그다음 질의 없이 확인 결과만 쓴다 (D1 2번)", async (reason, o) => {
    const first = hubTiles(H)[0];
    await seedPassing("skipKey" in o ? { skipKey: first } : { saturatedKey: first });
    const c = countingDb(env.DB);
    expect(await runPublishCheck(c.db, H, NOW)).toMatchObject({ pass: false, reason });
    expect(c.calls()).toBe(2);
    expect(await record()).toBeNull();
    expect(await check()).toMatchObject({ at: NOW, pass: false, reason });
    expect(isPublicHubId(ID)).toBe(false);
  });

  it("R68: 상세 미수집이 하나라도 있으면 missing (커버리지 집계 전에 멈춘다 — D1 3번)", async () => {
    await seedPassing();
    await replaceTilePlaces(env.DB, hubTiles(H)[0], ["7001"], NOW, false);
    const c = countingDb(env.DB);
    expect(await runPublishCheck(c.db, H, NOW)).toMatchObject({ pass: false, reason: "missing" });
    expect(c.calls()).toBe(3);
    expect(await record()).toBeNull();
  });

  it("R68: 상세 커버리지가 95 % 미만이면(Q2) coverage — 공개하지 않는다", async () => {
    await seedPassing();
    await replaceTilePlaces(env.DB, hubTiles(H)[0], ["7001", "7002"], NOW, false);
    await saveDetailFailure(env.DB, "7001", "http_500", NOW);
    await saveDetailFailure(env.DB, "7002", "http_500", NOW);
    expect(await runPublishCheck(env.DB, H, NOW)).toMatchObject({ pass: false, reason: "coverage", audit: { places: 22, ok: 20 } });
    expect(await record()).toBeNull();
  });

  it("R68: 후보마다 많아야 한 시간에 한 번(커버리지 실패 뒤는 6시간), 공개·숨김 기록이 있으면 다시 보지 않는다, 공개 후보만", () => {
    const hubs = [H];
    const key = HUB_PUBLIC_CHECK_PREFIX + ID;
    expect(pickPublishCheck(hubs, new Map(), NOW)).toBe(H);
    expect(pickPublishCheck(hubs, metaOf({ [key]: { at: NOW - PUBLISH_CHECK_INTERVAL_MS + 1, pass: false, reason: "missing" } }), NOW)).toBeNull();
    expect(pickPublishCheck(hubs, metaOf({ [key]: { at: NOW - PUBLISH_CHECK_INTERVAL_MS, pass: false, reason: "missing" } }), NOW)).toBe(H);
    expect(pickPublishCheck(hubs, metaOf({ [key]: { at: NOW - PUBLISH_CHECK_INTERVAL_MS, pass: false, reason: "coverage" } }), NOW)).toBeNull();
    expect(pickPublishCheck(hubs, metaOf({ [key]: { at: NOW - PUBLISH_COVERAGE_RETRY_MS, pass: false, reason: "coverage" } }), NOW)).toBe(H);
    for (const state of ["public", "hidden"]) {
      expect(pickPublishCheck(hubs, metaOf({ [HUB_PUBLIC_PREFIX + ID]: { state, at: NOW, by: "admin" } }), NOW), state).toBeNull();
    }
    // ready 거점은 후보가 아니다
    expect(pickPublishCheck([{ ...H, id: "ddp", ready: true }], new Map(), NOW)).toBeNull();
  });

  const cron = (now = NOW) =>
    runScheduled(env, { fetcher: routeFetch(fakeKakaoLocal([]).fetcher, fakePlaceApi({}).fetcher), now, sleep: async () => {}, hubs: [H] });

  it("R68: 본 Cron 한 번이 감사를 통과한 후보를 공개한다 (결과의 publish, D1 호출 상한 안) — 다음 실행은 다시 보지 않는다", async () => {
    await seedPassing();
    const r = await cron();
    expect(r.publish).toEqual({ hub: ID, pass: true, reason: null });
    expect(r.d1Calls).toBeLessThanOrEqual(45);
    expect(await record()).toMatchObject({ state: "public", by: "auto" });
    expect(isPublicHubId(ID)).toBe(true);
    const next = await cron(NOW + 5 * 60_000);
    expect(next.publish).toBeUndefined();
  });

  it("R68: 오늘 읽기가 소프트 한도 × DETAIL_ONLY_READ_SHARE에 닿으면 확인하지 않는다 (read_share — 확인 결과도 쓰지 않아 다음 실행이 다시 본다)", async () => {
    await seedPassing();
    await recordD1Usage(env.DB, { read: readSoftCap(env) * 0.6, written: 0 }, NOW);
    const r = await cron();
    expect(r.publish).toEqual({ hub: ID, skipped: "read_share" });
    expect(await check()).toBeNull();
    expect(await record()).toBeNull();
  });
});
