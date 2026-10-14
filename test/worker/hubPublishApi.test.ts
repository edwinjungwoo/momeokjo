import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREWARM_RADIUS } from "../../shared/constants";
import { tilesCoveringCircle } from "../../shared/geo";
import { HUBS, READY_HUBS, isPublicHubId } from "../../shared/hubs";
import { createApp } from "../../worker/app";
import { runSnapshotCron } from "../../worker/maintenance";
import {
  HUB_PUBLIC_PREFIX, PUBLIC_HUBS_TTL_MS, parsePublishRecord, resetPublicHubsCache,
} from "../../worker/publicHubs";
import { markTile } from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { UNREADY_HUB } from "../helpers/unreadyHub";

// R68: 공개 후보 동작은 테스트 전용 준비 중 거점으로 본다 — HUBS에 더한다
vi.mock("../../shared/hubs", async (orig) => (await import("../helpers/unreadyHub")).withUnreadyHub(orig));

const NOW = 1_800_000_000_000;
const ID = UNREADY_HUB.id;
const AUTH = { Authorization: "Bearer test-admin-token" };
const ANON = "0b0e7c6e-3f6b-4b8e-9a3e-1c2d3e4f5a6b";
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const record = async () => parsePublishRecord(
  (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(HUB_PUBLIC_PREFIX + ID).first<{ value: string }>())?.value,
);
const publishRow = (state: "public" | "hidden", by: "auto" | "admin" = "auto") =>
  env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
    .bind(HUB_PUBLIC_PREFIX + ID, JSON.stringify({ state, at: NOW, by })).run();

function setup(now = NOW) {
  const fetcher = routeFetch(fakeKakaoLocal([]).fetcher, fakePlaceApi({}).fetcher);
  return createApp({ fetcher, now: () => now, sleep: async () => {}, rateLimit: async () => true, adminRateLimit: async () => true });
}
const places = (now = NOW) => callApp(setup(now), `/api/places?hub=${ID}&radius=500`);
const hubsApi = async (now = NOW, init?: RequestInit) => callApp(setup(now), "/api/hubs", init);
const eventCount = async () => (await env.DB.prepare("SELECT count(*) AS n FROM events WHERE hub = ?").bind(ID).first<{ n: number }>())!.n;
const postEvent = (now = NOW) =>
  callApp(setup(now), "/api/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ anon: ANON, session: SESSION, events: [{ t: "draw", ts: now - 1000, hub: ID }] }),
  });

beforeEach(() => resetPublicHubsCache());
afterEach(() => resetPublicHubsCache());

describe("R68 런타임 공개 — 공개 API", () => {
  it("R68: 공개 전 후보는 /api/places 400, 공개 기록이 생기면 (늦어도 캐시 TTL 뒤) 200, 숨기면 다시 400", async () => {
    expect((await places()).status).toBe(400);
    await publishRow("public");
    // 이 격리 공간은 TTL 안에서 알던 목록을 쓴다 — TTL 뒤에 공개가 보인다
    expect((await places(NOW + 1000)).status).toBe(400);
    expect((await places(NOW + PUBLIC_HUBS_TTL_MS)).status).toBe(200);
    await publishRow("hidden", "admin");
    expect((await places(NOW + 2 * PUBLIC_HUBS_TTL_MS)).status).toBe(400);
  });

  it("R68: GET /api/hubs는 공개 거점(ready ∪ 공개된 후보)만 {id, name, lat, lng, refreshDay}로 — ETag가 같으면 304, 짧은 브라우저 캐시", async () => {
    const res = await hubsApi();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"h-[0-9a-f]+"$/);
    const body = await res.json<{ hubs: Record<string, unknown>[] }>();
    expect(body.hubs).toEqual(READY_HUBS.map(({ id, name, lat, lng, refreshDay }) => ({ id, name, lat, lng, refreshDay })));
    const again = await hubsApi(NOW, { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    await publishRow("public");
    const after = await hubsApi(NOW + PUBLIC_HUBS_TTL_MS, { headers: { "if-none-match": etag! } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect((await after.json<{ hubs: { id: string }[] }>()).hubs.map((h) => h.id)).toEqual([...READY_HUBS.map((h) => h.id), ID]);
  });

  it("R68: 이벤트 검증도 런타임 목록 — 공개 전 후보의 이벤트는 버리고, 공개 뒤에는 받는다", async () => {
    expect((await postEvent()).status).toBe(204);
    expect(await eventCount()).toBe(0);
    await publishRow("public");
    expect((await postEvent(NOW + PUBLIC_HUBS_TTL_MS)).status).toBe(204);
    expect(await eventCount()).toBe(1);
  });

  it("R68: 스냅샷 Cron은 새로 공개된 후보도 만들고, 공개를 취소하면 그 행을 지운다", async () => {
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    await publishRow("public");
    const built = new Set<string>();
    for (let i = 0; i < HUBS.length + 2; i++) {
      const r = await runSnapshotCron(env, { now: NOW + i * 5 * 60_000 });
      if ("hub" in r && r.status === "built") built.add(r.hub);
    }
    expect(built.has(ID)).toBe(true);
    expect([...built].sort()).toEqual(HUBS.map((h) => h.id).sort());
    await publishRow("hidden", "admin");
    await runSnapshotCron(env, { now: NOW + (HUBS.length + 2) * 5 * 60_000 + PUBLIC_HUBS_TTL_MS });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM hub_snapshots WHERE hub = ?").bind(ID).first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("R68 관리자 지금 공개·공개 취소", () => {
  const post = (path: string, headers: Record<string, string> = AUTH, e: Env = env) =>
    callApp(setup(), path, { method: "POST", headers }, e);

  it("R68: 토큰이 없으면 401, 후보가 아닌 거점(ready·모르는 id)은 400, 읽기 전용(개발 서버)이면 403", async () => {
    expect((await post(`/api/admin/hubs/publish?hub=${ID}`, {})).status).toBe(401);
    expect((await post("/api/admin/hubs/publish?hub=ddp")).status).toBe(400);
    expect((await post("/api/admin/hubs/unpublish?hub=atlantis")).status).toBe(400);
    expect((await post(`/api/admin/hubs/publish?hub=${ID}`, AUTH, { ...env, READ_ONLY: "1" } as Env)).status).toBe(403);
    expect(await record()).toBeNull();
  });

  it("R68: 지금 공개는 공개 기록(by admin)을 쓰고 이 격리 공간에 바로 보인다 — 공개 취소는 숨김 기록(by admin)이라 places 400·Cron이 다시 공개하지 않는다", async () => {
    const pub = await post(`/api/admin/hubs/publish?hub=${ID}`);
    expect(pub.status).toBe(200);
    expect(await pub.json()).toMatchObject({ hub: ID, state: "public", publicHubIds: expect.arrayContaining([ID, "bongeunsa"]) });
    expect(await record()).toMatchObject({ state: "public", by: "admin", at: NOW });
    expect(isPublicHubId(ID)).toBe(true);
    expect((await places()).status).toBe(200);
    const un = await post(`/api/admin/hubs/unpublish?hub=${ID}`);
    expect(un.status).toBe(200);
    expect(await un.json()).toMatchObject({ hub: ID, state: "hidden" });
    expect(await record()).toMatchObject({ state: "hidden", by: "admin", at: NOW });
    expect(isPublicHubId(ID)).toBe(false);
    expect((await places()).status).toBe(400);
  });
});
