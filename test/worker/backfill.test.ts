import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASEM } from "../../shared/constants";
import { tileKeyOf } from "../../shared/geo";
import { HUBS } from "../../shared/hubs";
import { utcDay } from "../../shared/kst";
import { createApp } from "../../worker/app";
import { LIST_JSON_PREFIX } from "../../worker/present";
import { ADMIN_BACKFILL_DEFAULT, ADMIN_BACKFILL_MAX, ADMIN_BACKFILL_SQL, replaceTilePlaces, saveDetailFailure } from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { seedPlace } from "../helpers/places";

const NOW = 1_800_000_000_000;
const AUTH = { Authorization: "Bearer test-admin-token" };
const hub = (id: string) => HUBS.find((h) => h.id === id)!;
const DDP = hub("ddp");
const BONG = hub("bongeunsa");

type Res = { filled: number; remaining: "more" | 0; rowsRead: number; rowsWritten: number };

function makeApp(opts: { admin?: () => boolean } = {}) {
  return createApp({
    fetcher: async () => new Response("", { status: 500 }),
    now: () => NOW,
    sleep: async () => {},
    rateLimit: async () => true,
    adminRateLimit: async () => (opts.admin ? opts.admin() : true),
  });
}
const backfill = (app: ReturnType<typeof makeApp>, query = "", headers: Record<string, string> = AUTH) =>
  callApp(app, `/api/admin/backfill${query}`, { method: "POST", headers });

/** 거점 중심 칸에 가게를 저장하고 격자에 기록한다 */
async function seedIn(center: { lat: number; lng: number }, ids: string[]) {
  for (const id of ids) await seedPlace(env.DB, id, center.lat, center.lng, { now: NOW - 1000 });
  await replaceTilePlaces(env.DB, tileKeyOf(center), ids, NOW, false);
}
const listJson = async (id: string) =>
  (await env.DB.prepare("SELECT list_json FROM places WHERE id = ?").bind(id).first<{ list_json: string | null }>())?.list_json ?? null;
/** 지금 조각을 기억해 두고 NULL로 비운다 (0005 전 행처럼) */
async function clearAll(): Promise<Map<string, string>> {
  const r = await env.DB.prepare("SELECT id, list_json FROM places WHERE list_json IS NOT NULL").all<{ id: string; list_json: string }>();
  await env.DB.prepare("UPDATE places SET list_json = NULL").run();
  return new Map(r.results.map((x) => [x.id, x.list_json]));
}
const nullsIn = async (ids: string[]) => {
  let n = 0;
  for (const id of ids) if ((await listJson(id)) === null) n++;
  return n;
};

/** 같은 가게를 n개 복제해 한 칸에 기록한다 (상한 테스트용 — saveDetail을 n번 부르지 않는다) */
async function cloneIn(center: { lat: number; lng: number }, n: number): Promise<string[]> {
  await seedIn(center, ["seed"]);
  await env.DB.prepare(
    `WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < ?)
     INSERT INTO places (id, status, name, category_name, category_group, lat, lng, address, phone, rating, review_count, price,
       menus_json, hours_json, strengths_json, tags_json, bookable, fail_reason, fetched_at, photo_url, list_json)
     SELECT 'c' || i, status, name || i, category_name, category_group, lat, lng, address, phone, rating, review_count, price,
       menus_json, hours_json, strengths_json, tags_json, bookable, fail_reason, fetched_at, photo_url, NULL
     FROM k, places WHERE places.id = 'seed'`,
  )
    .bind(n - 1)
    .run();
  const ids = ["seed", ...Array.from({ length: n - 1 }, (_, i) => `c${i + 1}`)];
  await env.DB.prepare("INSERT OR IGNORE INTO tile_places (tile_key, place_id) SELECT ?, value FROM json_each(?)")
    .bind(tileKeyOf(center), JSON.stringify(ids))
    .run();
  await env.DB.prepare("UPDATE places SET list_json = NULL").run();
  return ids;
}

describe("admin backfill (list_json)", () => {
  it("R12: 거점 격자 안의 list_json이 없는 ok 행만 Cron·saveDetail과 같은 조각(글자까지)으로 채운다", async () => {
    await seedIn(DDP, ["a", "b", "keep", "fail"]);
    await saveDetailFailure(env.DB, "fail", "http_500", NOW - 500); // 표시 정보는 남았지만 status failed
    await saveDetailFailure(env.DB, "nodetail", "http_500", NOW - 500); // 표시 정보 없음
    await replaceTilePlaces(env.DB, tileKeyOf(DDP), ["a", "b", "keep", "fail", "nodetail"], NOW, false);
    await seedPlace(env.DB, "outside", ASEM.lat, ASEM.lng, { now: NOW - 1000 }); // 어느 거점 격자에도 없다
    const want = await clearAll();
    await env.DB.prepare("UPDATE places SET list_json = ? WHERE id = 'keep'").bind(`${LIST_JSON_PREFIX}{"keep":1}`).run();

    const res = await backfill(makeApp());
    expect(res.status).toBe(200);
    const r = await res.json<Res>();
    expect(r).toMatchObject({ filled: 2, remaining: 0 });
    expect(r.rowsRead).toBeGreaterThan(0);
    expect(r.rowsWritten).toBeGreaterThan(0);
    expect(await listJson("a")).toBe(want.get("a"));
    expect(await listJson("b")).toBe(want.get("b"));
    expect(await listJson("keep")).toBe(`${LIST_JSON_PREFIX}{"keep":1}`);
    expect(await listJson("fail")).toBeNull();
    expect(await listJson("nodetail")).toBeNull();
    expect(await listJson("outside")).toBeNull();
  });

  it("R12: 판이 다르거나(LIST_JSON_VERSION) 깨진 조각도 Cron처럼 다시 쓰고, 지금 판 조각은 두며, 다시 부르면 0", async () => {
    await seedIn(DDP, ["old", "v0", "v2", "corrupt", "keep", "null"]);
    const want = await clearAll();
    const item = want.get("old")!.slice(LIST_JSON_PREFIX.length);
    const set = (id: string, v: string | null) => env.DB.prepare("UPDATE places SET list_json = ? WHERE id = ?").bind(v, id).run();
    await set("old", item);
    await set("v0", `v0:${item}`);
    await set("v2", `v2:${item}`);
    await set("corrupt", "v1:garbage");
    await set("keep", `${LIST_JSON_PREFIX}{"keep":1}`);
    const app = makeApp();
    expect(await (await backfill(app, "?hub=ddp")).json<Res>()).toMatchObject({ filled: 5, remaining: 0 });
    for (const id of ["old", "v0", "v2", "corrupt", "null"]) expect(await listJson(id), id).toBe(want.get(id));
    expect(await listJson("keep")).toBe(`${LIST_JSON_PREFIX}{"keep":1}`);
    expect(await (await backfill(app, "?hub=ddp")).json<Res>()).toMatchObject({ filled: 0, remaining: 0, rowsWritten: 0 });
  });

  it("R12: 두 번째 호출은 채울 것이 없어 0 (쓰기 0)", async () => {
    await seedIn(DDP, ["a", "b"]);
    await clearAll();
    const app = makeApp();
    expect(await (await backfill(app)).json<Res>()).toMatchObject({ filled: 2, remaining: 0 });
    expect(await (await backfill(app)).json<Res>()).toMatchObject({ filled: 0, remaining: 0, rowsWritten: 0 });
  });

  it("R12: hub를 주면 그 거점 격자만 채우고, 없으면 모든 거점 격자를 채운다. 모르는 hub는 400", async () => {
    await seedIn(DDP, ["d1", "d2"]);
    await seedIn(BONG, ["b1", "b2", "b3"]);
    await clearAll();
    const app = makeApp();
    expect(await (await backfill(app, "?hub=ddp")).json<Res>()).toMatchObject({ filled: 2, remaining: 0 });
    expect(await nullsIn(["d1", "d2"])).toBe(0);
    expect(await nullsIn(["b1", "b2", "b3"])).toBe(3);
    expect(await (await backfill(app, "?hub=ddp")).json<Res>()).toMatchObject({ filled: 0, remaining: 0 });
    expect(await (await backfill(app, "?hub=bongeunsa&limit=2")).json<Res>()).toMatchObject({ filled: 2, remaining: "more" });
    expect(await (await backfill(app)).json<Res>()).toMatchObject({ filled: 1, remaining: 0 });
    expect(await nullsIn(["b1", "b2", "b3"])).toBe(0);
    expect((await backfill(app, "?hub=nowhere")).status).toBe(400);
  });

  it(`R12: limit 기본값은 ADMIN_BACKFILL_DEFAULT, 최댓값 ADMIN_BACKFILL_MAX — 더 크면 최댓값으로 줄이고, 1 미만·숫자 아님은 400`, async () => {
    expect(ADMIN_BACKFILL_DEFAULT).toBe(300);
    expect(ADMIN_BACKFILL_MAX).toBe(300);
    const ids = await cloneIn(DDP, ADMIN_BACKFILL_DEFAULT + ADMIN_BACKFILL_MAX + 1);
    const app = makeApp();
    expect(await (await backfill(app)).json<Res>()).toMatchObject({ filled: ADMIN_BACKFILL_DEFAULT, remaining: "more" });
    expect(await (await backfill(app, "?hub=ddp&limit=99999")).json<Res>()).toMatchObject({ filled: ADMIN_BACKFILL_MAX, remaining: "more" });
    expect(await (await backfill(app, "?limit=3")).json<Res>()).toMatchObject({ filled: 1, remaining: 0 });
    expect(await nullsIn(ids)).toBe(0);
    for (const bad of ["0", "-1", "abc", "1.5"]) expect((await backfill(app, `?limit=${bad}`)).status, bad).toBe(400);
  });

  it("R38: 후보는 격자 기록(tile_places)에서 출발해 PK로 찾는다 — places를 훑지 않는다", async () => {
    const plan = (await env.DB.prepare(`EXPLAIN QUERY PLAN ${ADMIN_BACKFILL_SQL}`).bind("[]", 1).all<{ detail: string }>()).results
      .map((x) => x.detail)
      .join("\n");
    expect(plan).toContain("SEARCH tp USING COVERING INDEX sqlite_autoindex_tile_places_1 (tile_key=?)");
    expect(plan).toContain("SEARCH p USING INDEX sqlite_autoindex_places_1 (id=?)");
    expect(plan).not.toMatch(/SCAN (p|places|tp)\b/);
  });

  it("R12: 한 가게가 두 칸에 기록돼 있어도 한 번만 센다", async () => {
    await seedIn(DDP, ["a", "b"]);
    const other = tileKeyOf({ lat: DDP.lat - 0.003, lng: DDP.lng }); // 키 순서상 a가 먼저 두 번 나온다
    await replaceTilePlaces(env.DB, other, ["a"], NOW, false);
    await clearAll();
    expect(await (await backfill(makeApp(), "?hub=ddp&limit=2")).json<Res>()).toMatchObject({ filled: 2 });
    expect(await nullsIn(["a", "b"])).toBe(0);
  });

  it("R36: 토큰이 없거나 틀리면 401, ADMIN_LIMITER를 넘으면 맞는 토큰이어도 429 rate_limited — 둘 다 아무것도 채우지 않는다", async () => {
    await seedIn(DDP, ["a"]);
    await clearAll();
    expect((await backfill(makeApp(), "", {})).status).toBe(401);
    expect((await backfill(makeApp(), "", { Authorization: "Bearer nope" })).status).toBe(401);
    const limited = await backfill(makeApp({ admin: () => false }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect(await listJson("a")).toBeNull();
  });

  it("R38: 오늘 D1 읽기·쓰기가 소프트 한도 이상이면 채우지 않고 429 read_budget / write_budget", async () => {
    await seedIn(DDP, ["a"]);
    await clearAll();
    const day = utcDay(NOW);
    const setUsage = (read: number, written: number) =>
      env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(`d1_read:${day}`, String(read)),
        env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").bind(`d1_written:${day}`, String(written)),
      ]);
    await setUsage(3_000_000, 0);
    const r1 = await backfill(makeApp());
    expect(r1.status).toBe(429);
    expect(await r1.json()).toEqual({ error: "read_budget" });
    await setUsage(0, 60_000);
    const r2 = await backfill(makeApp());
    expect(r2.status).toBe(429);
    expect(await r2.json()).toEqual({ error: "write_budget" });
    expect(await listJson("a")).toBeNull();
  });
});
