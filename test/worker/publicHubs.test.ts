import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HUBS, READY_HUBS, isPublicHubId, publicHubs } from "../../shared/hubs";
import {
  HUB_PUBLIC_PREFIX, PUBLIC_HUBS_RETRY_MS, PUBLIC_HUBS_TTL_MS, ensurePublicHubs, parsePublishRecord, publishedFromMeta,
  resetPublicHubsCache,
} from "../../worker/publicHubs";
import { countingDb } from "../helpers/recordDb";
import { UNREADY_HUB } from "../helpers/unreadyHub";

// R68: 공개 후보 동작은 테스트 전용 준비 중 거점으로 본다 — HUBS에 더한다
vi.mock("../../shared/hubs", async (orig) => (await import("../helpers/unreadyHub")).withUnreadyHub(orig));

const NOW = 1_800_000_000_000;
const KEY = HUB_PUBLIC_PREFIX + UNREADY_HUB.id;
const setRecord = (value: unknown) =>
  env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(KEY, JSON.stringify(value)).run();

beforeEach(() => resetPublicHubsCache());
afterEach(() => resetPublicHubsCache());

describe("R68 런타임 공개 거점 — 서버 캐시", () => {
  it("R68: 공개 기록(state public)이 있는 후보만 공개 — 숨김 기록·깨진 값·모르는 거점은 아니다", () => {
    expect(parsePublishRecord(JSON.stringify({ state: "public", at: 1, by: "auto" }))).toEqual({ state: "public", at: 1, by: "auto" });
    for (const raw of [undefined, "", "{", "null", '{"state":"public"}', '{"state":"weird","at":1,"by":"auto"}', '{"state":"public","at":1,"by":"x"}']) {
      expect(parsePublishRecord(raw), String(raw)).toBeNull();
    }
    const meta = new Map([
      [KEY, JSON.stringify({ state: "public", at: 1, by: "auto" })],
      [`${HUB_PUBLIC_PREFIX}ddp`, JSON.stringify({ state: "public", at: 1, by: "admin" })],
      [`${HUB_PUBLIC_PREFIX}atlantis`, JSON.stringify({ state: "public", at: 1, by: "admin" })],
    ]);
    expect(publishedFromMeta(meta)).toEqual([UNREADY_HUB.id]);
    expect(publishedFromMeta(new Map([[KEY, JSON.stringify({ state: "hidden", at: 1, by: "admin" })]]))).toEqual([]);
  });

  it("R68: 격리 공간마다 meta를 한 번 읽어 TTL(5분) 동안 쓴다 — 그 사이 다시 읽지 않고, 지나면 다시 읽어 공개·숨김을 따라간다", async () => {
    expect(PUBLIC_HUBS_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
    const c = countingDb(env.DB);
    await ensurePublicHubs(c.db, NOW);
    expect(c.calls()).toBe(1);
    expect(isPublicHubId(UNREADY_HUB.id)).toBe(false);
    await setRecord({ state: "public", at: NOW, by: "auto" });
    await ensurePublicHubs(c.db, NOW + PUBLIC_HUBS_TTL_MS - 1);
    expect(c.calls()).toBe(1);
    expect(isPublicHubId(UNREADY_HUB.id)).toBe(false);
    await ensurePublicHubs(c.db, NOW + PUBLIC_HUBS_TTL_MS);
    expect(c.calls()).toBe(2);
    expect(isPublicHubId(UNREADY_HUB.id)).toBe(true);
    expect(publicHubs().map((h) => h.id)).toContain(UNREADY_HUB.id);
    await setRecord({ state: "hidden", at: NOW, by: "admin" });
    await ensurePublicHubs(c.db, NOW + 2 * PUBLIC_HUBS_TTL_MS);
    expect(isPublicHubId(UNREADY_HUB.id)).toBe(false);
  });

  it("R68: 요청끼리 읽기를 나눠 쓰지 않는다 — 앞 요청의 읽기가 끝나지 않아도(취소된 요청) 다음 요청은 제 읽기로 끝난다", async () => {
    const hung = { prepare: () => ({ bind: () => ({ all: () => new Promise(() => {}) }) }) } as unknown as D1Database;
    void ensurePublicHubs(hung, NOW);
    await setRecord({ state: "public", at: NOW, by: "auto" });
    const c = countingDb(env.DB);
    await ensurePublicHubs(c.db, NOW);
    expect(c.calls()).toBe(1);
    expect(isPublicHubId(UNREADY_HUB.id)).toBe(true);
  });

  it("R68: 읽기가 실패하면 알던 목록을 그대로 두고 30초 뒤에 다시 읽는다 (던지지 않는다)", async () => {
    await setRecord({ state: "public", at: NOW, by: "auto" });
    await ensurePublicHubs(env.DB, NOW);
    expect(isPublicHubId(UNREADY_HUB.id)).toBe(true);
    const broken = { prepare: () => { throw new Error("d1 down"); } } as unknown as D1Database;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(ensurePublicHubs(broken, NOW + PUBLIC_HUBS_TTL_MS)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    expect(isPublicHubId(UNREADY_HUB.id)).toBe(true);
    const c = countingDb(env.DB);
    await ensurePublicHubs(c.db, NOW + PUBLIC_HUBS_TTL_MS + PUBLIC_HUBS_RETRY_MS - 1);
    expect(c.calls()).toBe(0);
    await ensurePublicHubs(c.db, NOW + PUBLIC_HUBS_TTL_MS + PUBLIC_HUBS_RETRY_MS);
    expect(c.calls()).toBe(1);
  });

  it("R68: 후보가 없으면(운영 HUBS가 모두 ready) D1을 읽지 않고 공개 거점은 ready뿐", async () => {
    HUBS.splice(HUBS.indexOf(UNREADY_HUB), 1);
    try {
      const c = countingDb(env.DB);
      await ensurePublicHubs(c.db, NOW);
      expect(c.calls()).toBe(0);
      expect(publicHubs()).toEqual(READY_HUBS);
    } finally {
      HUBS.push(UNREADY_HUB);
    }
  });
});
