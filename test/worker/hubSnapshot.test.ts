import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DETAIL_FREEZE_MS, LIST_JSON_VERSION, PLACE_BLOCK_COOLDOWN_MS, PREWARM_RADIUS, TILE_TTL_MS } from "../../shared/constants";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { HUBS, hubById, type Hub } from "../../shared/hubs";
import { utcDay } from "../../shared/kst";
import { PLACES_CACHE_MS, PLACES_CACHE_VERSION, createApp, placesCacheKey } from "../../worker/app";
import {
  HUB_SNAPSHOT_VERSION, SNAPSHOT_DIRTY_REBUILD_MS, SNAPSHOT_EDGE_CACHE_MS, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_REFRESH_BEFORE_MS,
  acceptsGzip, buildHubSnapshot, etagMatches, maintainSnapshots, readHubSnapshot, snapshotEdgeTtlMs,
} from "../../worker/hubSnapshot";
import { hubsOfTile } from "../../worker/hubTiles";
import { runScheduled } from "../../worker/maintenance";
import { markTile, recordPlaceBlock, replaceTilePlaces, saveDetail, saveDetailFailure } from "../../worker/repo";
import { SNAPSHOT_DIRTY_PREFIX, markHubsDirtyStmt } from "../../worker/snapshotDirty";
import { callApp } from "../helpers/callApp";
import { doc, fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { makeSummary, markOuterTilesFresh, placeJson, sampleDetail } from "../helpers/places";

const NOW = 1_800_000_000_000;
const HUB = hubById("bongeunsa");
const CENTER = { lat: HUB.lat, lng: HUB.lng };
const at = (dLat: number) => HUB.lat + dLat;
const DOCS = [
  doc("1001", at(0.0005), HUB.lng),
  doc("1002", at(0.001), HUB.lng, "음식점 > 중식"),
  doc("1004", at(0.004), HUB.lng),
];
const DETAILS = {
  "1001": placeJson({ name: "가게1001", lat: at(0.0005), lng: HUB.lng }),
  "1002": placeJson({ name: "가게1002", lat: at(0.001), lng: HUB.lng, category: ["음식점", "중식", "중국요리"] }),
  "1004": placeJson({ name: "가게1004", lat: at(0.004), lng: HUB.lng }),
};
const Q = "/api/places?hub=bongeunsa&radius=1000";
const GZIP = { "accept-encoding": "gzip, deflate, br" };

beforeEach(() => markOuterTilesFresh(env.DB, CENTER, 300, NOW));

/** 엣지 캐시 없는 앱 (언제나 미스) */
function makeApp(now: () => number = () => NOW, cache?: Cache) {
  const local = fakeKakaoLocal(DOCS);
  const place = fakePlaceApi({ ...DETAILS });
  const app = createApp({
    fetcher: routeFetch(local.fetcher, place.fetcher), now, sleep: async () => {}, rateLimit: async () => true, cache,
  });
  return { app, local, place };
}

/** 봉은사 1000m를 다 채운다 (격자 수집 → 보충) 그리고 지금 실제 경로의 본문을 돌려준다 */
async function seedHub(): Promise<string> {
  const { app } = makeApp();
  await callApp(app, Q); // 격자 수집, 응답 뒤 보충
  const res = await callApp(app, Q);
  expect(res.headers.get("x-mmj-source")).toBe("live");
  const body = await res.text();
  expect(JSON.parse(body)).toMatchObject({ pending: 0, incompleteTiles: 0, stale: false });
  return body;
}

const gunzip = async (res: Response) =>
  new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();
const stamp = async (hub: string) =>
  Number((await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT_DIRTY_PREFIX + hub).first<{ value: string }>())?.value ?? 0);
const snapshotRow = (hub: string) =>
  env.DB.prepare("SELECT hub, version, built_at, source_at, encoding, etag FROM hub_snapshots WHERE hub = ?").bind(hub)
    .first<{ hub: string; version: number; built_at: number; source_at: number; encoding: string; etag: string }>();

describe("R56 거점 스냅샷 — 만들기와 내보내기", () => {
  it("R56: 스냅샷 본문은 지금 경로(캐시 미스)의 본문과 글자까지 같고, gzip으로 한 행만 읽어 준다", async () => {
    const live = await seedHub();
    const r = await buildHubSnapshot(env.DB, HUB, NOW);
    expect(r).toMatchObject({ status: "built", hub: "bongeunsa" });
    const row = await snapshotRow("bongeunsa");
    expect(row).toMatchObject({ version: HUB_SNAPSHOT_VERSION, built_at: NOW, encoding: "gzip" });

    const { app } = makeApp();
    const usage = async () =>
      Number((await env.DB.prepare("SELECT value FROM meta WHERE key LIKE 'd1_read:%'").first<{ value: string }>())?.value ?? 0);
    const before = await usage();
    const res = await callApp(app, Q, { headers: GZIP });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-mmj-source")).toBe("snapshot");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("etag")).toBe(`W/${row!.etag}`);
    expect(await gunzip(res)).toBe(live);
    expect((await usage()) - before).toBe(1);
  });

  it("R56: gzip을 받지 않는 화면(Accept-Encoding 없음·identity·gzip;q=0)에는 풀어서 같은 JSON을 준다", async () => {
    const live = await seedHub();
    await buildHubSnapshot(env.DB, HUB, NOW);
    const { app } = makeApp();
    const variants: Record<string, string>[] = [{}, { "accept-encoding": "identity" }, { "accept-encoding": "br, gzip;q=0" }];
    for (const headers of variants) {
      const res = await callApp(app, Q, { headers });
      expect(res.headers.get("x-mmj-source")).toBe("snapshot");
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.text()).toBe(live);
    }
    expect(acceptsGzip("gzip")).toBe(true);
    expect(acceptsGzip("deflate, GZIP;q=0.5")).toBe(true);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("gzip;q=0, *")).toBe(false);
    expect(acceptsGzip("br")).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
  });

  it("R12/R56: 거리가 같은 가게(같은 건물)는 id순 — D1이 주는 행 순서와 상관없이 같은 데이터면 같은 본문", async () => {
    await seedHub();
    const lat = at(0.0005);
    // 1001과 같은 좌표에 id가 더 작은 가게를 나중에 넣는다 (rowid 순서는 1001이 먼저)
    await env.DB.prepare("INSERT INTO tile_places (tile_key, place_id) VALUES (?, '1000')").bind(tileKeyOf({ lat, lng: HUB.lng })).run();
    await saveDetail(env.DB, "1000", makeSummary(lat, HUB.lng, { name: "같은 건물" }), sampleDetail(), NOW);
    const { app } = makeApp();
    const ids = ((await (await callApp(app, Q)).json()) as { places: { id: string }[] }).places.map((p) => p.id);
    expect(ids.slice(0, 2)).toEqual(["1000", "1001"]);
  });

  it("R56: gzip은 풀면 원래 본문으로 돌아온다 (왕복)", async () => {
    const live = await seedHub();
    await buildHubSnapshot(env.DB, HUB, NOW);
    const snap = await readHubSnapshot(env.DB, "bongeunsa", NOW, undefined);
    expect(snap?.body).toBeInstanceOf(Uint8Array);
    expect(await gunzip(new Response(snap!.body))).toBe(live);
  });

  it("R56: 판(version)이 다르거나 인코딩이 모르는 값이면 쓰지 않고 지금 경로로 답한다", async () => {
    const live = await seedHub();
    await buildHubSnapshot(env.DB, HUB, NOW);
    const { app } = makeApp();
    for (const sql of ["UPDATE hub_snapshots SET version = version + 1", "UPDATE hub_snapshots SET encoding = 'br'"]) {
      await buildHubSnapshot(env.DB, HUB, NOW);
      await env.DB.prepare(sql).run();
      const res = await callApp(app, Q, { headers: GZIP });
      expect(res.headers.get("x-mmj-source")).toBe("live");
      expect(await res.text()).toBe(live);
    }
  });

  it("R56: 만든 지 SNAPSHOT_MAX_AGE_MS가 지나면 쓰지 않는다 (미래 시각도)", async () => {
    await seedHub();
    await buildHubSnapshot(env.DB, HUB, NOW);
    expect(await readHubSnapshot(env.DB, "bongeunsa", NOW + SNAPSHOT_MAX_AGE_MS - 1, undefined)).not.toBeNull();
    expect(await readHubSnapshot(env.DB, "bongeunsa", NOW + SNAPSHOT_MAX_AGE_MS, undefined)).toBeNull();
    expect(await readHubSnapshot(env.DB, "bongeunsa", NOW - 1, undefined)).toBeNull();
    const { app } = makeApp(() => NOW + SNAPSHOT_MAX_AGE_MS);
    expect((await callApp(app, Q, { headers: GZIP })).headers.get("x-mmj-source")).toBe("live");
  });

  it("R56: pending이 남았으면 만들지 않는다 (지금 경로가 보충을 시작하고 pending을 알린다)", async () => {
    await seedHub();
    await env.DB.prepare("DELETE FROM places WHERE id = '1002'").run();
    expect(await buildHubSnapshot(env.DB, HUB, NOW)).toMatchObject({ status: "skipped", reason: "pending" });
    expect(await snapshotRow("bongeunsa")).toBeNull();
  });

  it("R56: 거점 격자 중 만료됐거나 수집하지 않은 격자가 있으면 만들지 않는다 (incompleteTiles·stale은 지금 경로가 정한다)", async () => {
    await seedHub();
    const keys = tilesCoveringCircle(HUB, PREWARM_RADIUS);
    await markTile(env.DB, keys[0], NOW - TILE_TTL_MS, 0, false);
    expect(await buildHubSnapshot(env.DB, HUB, NOW)).toMatchObject({ status: "skipped", reason: "tiles" });
    await env.DB.prepare("DELETE FROM tiles WHERE key = ?").bind(keys[0]).run();
    expect(await buildHubSnapshot(env.DB, HUB, NOW)).toMatchObject({ status: "skipped", reason: "tiles" });
    expect(await snapshotRow("bongeunsa")).toBeNull();
  });

  it("R56/R10: 쿨다운이 쓰는 동안(SNAPSHOT_MAX_AGE_MS) 안에 끝나면 만들지 않는다 — detailsPaused가 틀린 채로 남지 않게", async () => {
    await seedHub();
    await recordPlaceBlock(env.DB, NOW);
    expect(PLACE_BLOCK_COOLDOWN_MS).toBeLessThan(SNAPSHOT_MAX_AGE_MS);
    expect(await buildHubSnapshot(env.DB, HUB, NOW)).toMatchObject({ status: "skipped", reason: "paused" });
  });

  it("R56/R44: frozen이 쓰는 동안 계속되면 detailsPaused·detailsFrozenSince까지 지금 경로와 같은 본문으로 만든다", async () => {
    await seedHub();
    const frozen = { mode: "frozen", since: NOW - 1000, until: NOW + DETAIL_FREEZE_MS };
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('detail_mode', ?)").bind(JSON.stringify(frozen)).run();
    const { app } = makeApp();
    const live = await (await callApp(app, Q)).text();
    expect(JSON.parse(live)).toMatchObject({ detailsPaused: true, detailsFrozenSince: NOW - 1000 });
    expect(await buildHubSnapshot(env.DB, HUB, NOW)).toMatchObject({ status: "built" });
    const res = await callApp(app, Q, { headers: GZIP });
    expect(res.headers.get("x-mmj-source")).toBe("snapshot");
    expect(await gunzip(res)).toBe(live);
    // 해제가 쓰는 동안 안에 오면 만들지 않는다
    await env.DB.prepare("UPDATE meta SET value = ? WHERE key = 'detail_mode'")
      .bind(JSON.stringify({ ...frozen, until: NOW + SNAPSHOT_MAX_AGE_MS - 1 })).run();
    expect(await buildHubSnapshot(env.DB, HUB, NOW)).toMatchObject({ status: "skipped", reason: "paused" });
  });

  it("R56: 만드는 사이 거점이 더러워지면(표시가 바뀜) 저장하지 않는다 — 다음 실행이 다시 만든다", async () => {
    await seedHub();
    // 목록 조회가 실행될 때 다른 요청이 같은 거점의 상세를 저장한 것처럼 표시를 올린다
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!sql.includes("FROM tile_places tp LEFT JOIN places")) return stmt;
          return new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") {
                return (...args: unknown[]) => {
                  const bound = s.bind(...args);
                  return new Proxy(bound, {
                    get(b, q) {
                      if (q === "all") return async () => {
                        await markHubsDirtyStmt(target, ["bongeunsa"], NOW + 5).run();
                        return b.all();
                      };
                      const v = Reflect.get(b, q);
                      return typeof v === "function" ? v.bind(b) : v;
                    },
                  });
                };
              }
              const v = Reflect.get(s, p);
              return typeof v === "function" ? v.bind(s) : v;
            },
          });
        };
      },
    });
    expect(await buildHubSnapshot(racing, HUB, NOW)).toMatchObject({ status: "skipped", reason: "raced" });
    expect(await snapshotRow("bongeunsa")).toBeNull();
  });
});

describe("R56 거점 스냅샷 — ETag와 304", () => {
  it("R56: If-None-Match가 스냅샷 ETag와 같으면 본문 없이 304 (스냅샷 경로와 엣지 캐시 적중 둘 다)", async () => {
    await seedHub();
    await buildHubSnapshot(env.DB, HUB, NOW);
    const cache = caches.default;
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
    const { app } = makeApp(() => NOW, cache);
    const first = await callApp(app, Q, { headers: GZIP });
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"\d+-bongeunsa-[0-9a-f]{16}"$/);
    await first.arrayBuffer();
    // 엣지 캐시 적중에서 304
    const hit = await callApp(app, Q, { headers: { ...GZIP, "if-none-match": etag } });
    expect(hit.status).toBe(304);
    expect(hit.headers.get("x-mmj-source")).toBe("edge");
    expect(hit.headers.get("etag")).toBe(etag);
    expect(await hit.text()).toBe("");
    // 엣지 캐시가 비어도 스냅샷 행으로 304 (본문 열은 받지 않는다)
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
    const miss = await callApp(app, Q, { headers: { "if-none-match": `"x", ${etag}` } });
    expect(miss.status).toBe(304);
    expect(miss.headers.get("x-mmj-source")).toBe("snapshot");
    expect(await miss.text()).toBe("");
    const meta = await readHubSnapshot(env.DB, "bongeunsa", NOW, etag);
    expect(meta).toMatchObject({ notModified: true, body: null });
    // 다른 ETag면 본문
    const other = await callApp(app, Q, { headers: { ...GZIP, "if-none-match": 'W/"1-bongeunsa-0000000000000000"' } });
    expect(other.status).toBe(200);
    await other.arrayBuffer();
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
  });

  it("R56: 지금 경로(스냅샷 없음) 응답에는 ETag가 없고 If-None-Match를 보내도 200 본문", async () => {
    const live = await seedHub();
    const { app } = makeApp();
    const res = await callApp(app, Q, { headers: { "if-none-match": "*" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    expect(await res.text()).toBe(live);
  });

  it("R56: 본문이 같으면 다시 만들어도 ETag가 같다 (화면의 저장본이 계속 304를 받는다) — 바뀌면 다르다", async () => {
    await seedHub();
    await buildHubSnapshot(env.DB, HUB, NOW);
    const a = (await snapshotRow("bongeunsa"))!.etag;
    await buildHubSnapshot(env.DB, HUB, NOW + 60_000);
    expect((await snapshotRow("bongeunsa"))!.etag).toBe(a);
    await saveDetail(env.DB, "1001", makeSummary(at(0.0005), HUB.lng, { name: "새 이름" }), sampleDetail(), NOW + 1);
    await buildHubSnapshot(env.DB, HUB, NOW + 120_000);
    expect((await snapshotRow("bongeunsa"))!.etag).not.toBe(a);
  });

  it("R56: If-None-Match 비교 — 약한 비교, 목록, *", () => {
    const e = '"7001-ddp-0123456789abcdef"';
    expect(etagMatches(`W/${e}`, e)).toBe(true);
    expect(etagMatches(e, e)).toBe(true);
    expect(etagMatches(`"a", W/${e}`, e)).toBe(true);
    expect(etagMatches("*", e)).toBe(true);
    expect(etagMatches('"7001-ddp-0123456789abcdee"', e)).toBe(false);
    expect(etagMatches(undefined, e)).toBe(false);
    expect(etagMatches("", e)).toBe(false);
  });
});

describe("R56 거점 스냅샷 — 엣지 캐시", () => {
  it("R56: 스냅샷으로 답한 응답은 엣지에 10분 두고(쓸 수 있는 남은 시간이 더 짧으면 그만큼), 적중도 gzip·ETag로 준다", async () => {
    const live = await seedHub();
    await buildHubSnapshot(env.DB, HUB, NOW);
    const cache = caches.default;
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
    const { app } = makeApp(() => NOW, cache);
    await (await callApp(app, Q, { headers: GZIP })).arrayBuffer();
    const stored = await cache.match(new Request(placesCacheKey("bongeunsa")));
    expect(stored?.headers.get("cache-control")).toBe("public, max-age=600, s-maxage=600");
    await stored?.arrayBuffer();
    // D1을 비워도 엣지 적중
    await env.DB.prepare("DELETE FROM hub_snapshots").run();
    const hit = await callApp(app, Q, { headers: GZIP });
    expect(hit.headers.get("x-mmj-source")).toBe("edge");
    expect(hit.headers.get("content-encoding")).toBe("gzip");
    expect(hit.headers.get("etag")).toMatch(/^W\//);
    expect(await gunzip(hit)).toBe(live);
    const plain = await callApp(app, Q);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(live);
    await cache.delete(new Request(placesCacheKey("bongeunsa")));

    expect(SNAPSHOT_EDGE_CACHE_MS).toBe(600_000);
    expect(snapshotEdgeTtlMs(NOW, NOW)).toBe(SNAPSHOT_EDGE_CACHE_MS);
    expect(snapshotEdgeTtlMs(NOW, NOW + SNAPSHOT_MAX_AGE_MS - 120_000)).toBe(120_000);
    expect(snapshotEdgeTtlMs(NOW, NOW + SNAPSHOT_MAX_AGE_MS - 10)).toBe(1000);
  });

  it("R56: 지금 경로 응답의 엣지 캐시 시간은 그대로 (다 찬 응답 60초)", async () => {
    await seedHub();
    const cache = caches.default;
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
    const { app } = makeApp(() => NOW, cache);
    await (await callApp(app, Q)).arrayBuffer();
    const stored = await cache.match(new Request(placesCacheKey("bongeunsa")));
    expect(stored?.headers.get("cache-control")).toBe(`public, max-age=${PLACES_CACHE_MS / 1000}, s-maxage=${PLACES_CACHE_MS / 1000}`);
    await stored?.arrayBuffer();
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
  });
});

describe("R56 거점 스냅샷 — 더러움 표시와 무효화", () => {
  it("R56: 상세 저장은 그 가게가 1000m 상자 안에 있는 거점만 표시를 올린다 (예전 좌표가 안이었던 거점도)", async () => {
    const ddp = hubById("ddp");
    await saveDetail(env.DB, "9001", makeSummary(at(0.001), HUB.lng), sampleDetail(), NOW);
    const s1 = await stamp("bongeunsa");
    expect(s1).toBeGreaterThanOrEqual(NOW);
    expect(await stamp("ddp")).toBe(0);
    // 같은 ms에 또 바뀌어도 표시는 올라간다
    await saveDetail(env.DB, "9001", makeSummary(at(0.001), HUB.lng), sampleDetail(), NOW);
    expect(await stamp("bongeunsa")).toBeGreaterThan(s1);
    // 동대문 근처로 옮기면 두 거점 모두 (봉은사 목록에서 빠진다)
    const s2 = await stamp("bongeunsa");
    await saveDetail(env.DB, "9001", makeSummary(ddp.lat, ddp.lng), sampleDetail(), NOW + 1);
    expect(await stamp("bongeunsa")).toBeGreaterThan(s2);
    expect(await stamp("ddp")).toBeGreaterThanOrEqual(NOW + 1);
    // 어느 거점과도 먼 가게는 표시를 쓰지 않는다
    const before = await env.DB.prepare("SELECT count(*) AS c FROM meta WHERE key LIKE 'snapshot_dirty:%'").first<{ c: number }>();
    await saveDetail(env.DB, "9002", makeSummary(35.1, 129.0), sampleDetail(), NOW + 2);
    const after = await env.DB.prepare("SELECT count(*) AS c FROM meta WHERE key LIKE 'snapshot_dirty:%'").first<{ c: number }>();
    expect(after?.c).toBe(before?.c);
  });

  it("R56: 상세 실패 기록도 표시 정보가 있는 행이면 그 거점 표시를 올린다 (detailsNewestAt이 바뀐다)", async () => {
    await saveDetail(env.DB, "9001", makeSummary(at(0.001), HUB.lng), sampleDetail(), NOW);
    const s = await stamp("bongeunsa");
    await saveDetailFailure(env.DB, "9001", "http_500", NOW + 10);
    expect(await stamp("bongeunsa")).toBeGreaterThan(s);
    // 표시 정보 없는(한 번도 못 가져온) 행의 실패는 어느 거점에도 안 보인다
    const s2 = await stamp("bongeunsa");
    await saveDetailFailure(env.DB, "9999", "http_500", NOW + 20);
    expect(await stamp("bongeunsa")).toBe(s2);
  });

  it("R56: 격자에 ID가 새로 들어오면 그 격자를 덮는 거점 스냅샷을 지우고(pending이 생긴다) 표시를 올린다. 빠지기만 하면 표시만", async () => {
    await seedHub();
    await buildHubSnapshot(env.DB, HUB, NOW);
    const key = tileKeyOf({ lat: at(0.0005), lng: HUB.lng }); // 1001이 있는 칸
    expect(hubsOfTile(key)).toContain("bongeunsa");
    expect(hubsOfTile("0:0")).toEqual([]);
    const s = await stamp("bongeunsa");
    // 빠지기만 함
    const cur = await env.DB.prepare("SELECT place_id FROM tile_places WHERE tile_key = ?").bind(key).all<{ place_id: string }>();
    const ids = cur.results.map((r) => r.place_id);
    await replaceTilePlaces(env.DB, key, ids.slice(1), NOW + 1, false);
    expect(await snapshotRow("bongeunsa")).not.toBeNull();
    expect(await stamp("bongeunsa")).toBeGreaterThan(s);
    // 새 ID
    await replaceTilePlaces(env.DB, key, [...ids, "7777"], NOW + 2, false);
    expect(await snapshotRow("bongeunsa")).toBeNull();
    // 바뀐 것이 없으면 아무것도 하지 않는다
    await buildHubSnapshot(env.DB, HUB, NOW + 3);
    const s3 = await stamp("bongeunsa");
    await replaceTilePlaces(env.DB, key, [...ids, "7777"], NOW + 4, false);
    expect(await stamp("bongeunsa")).toBe(s3);
  });

  it("R56/R10/R44: 쿨다운이 새로 걸리면(frozen 포함) 모든 거점 스냅샷을 지우고 표시를 올린다", async () => {
    await seedHub();
    await buildHubSnapshot(env.DB, HUB, NOW);
    const s = await stamp("bongeunsa");
    await recordPlaceBlock(env.DB, NOW + 1);
    expect(await env.DB.prepare("SELECT count(*) AS c FROM hub_snapshots").first<{ c: number }>()).toEqual({ c: 0 });
    expect(await stamp("bongeunsa")).toBeGreaterThan(s);
    for (const h of HUBS) expect(await stamp(h.id)).toBeGreaterThan(0);
  });
});

describe("R56 거점 스냅샷 — Cron", () => {
  const hubs: Hub[] = [HUB, hubById("ddp"), hubById("pangyo")];
  const freshAll = async () => {
    for (const h of hubs) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
  };

  it("R56: 실행마다 한 거점만 만든다 — 없는 거점부터 돌아가며, 깨끗하고 젊은 스냅샷은 다시 만들지 않는다", async () => {
    await freshAll();
    const r1 = await maintainSnapshots(env.DB, hubs, NOW);
    const r2 = await maintainSnapshots(env.DB, hubs, NOW + 1);
    const r3 = await maintainSnapshots(env.DB, hubs, NOW + 2);
    expect([r1, r2, r3].map((r) => r.status)).toEqual(["built", "built", "built"]);
    expect([r1, r2, r3].map((r) => ("hub" in r ? r.hub : null))).toEqual(["bongeunsa", "ddp", "pangyo"]);
    expect(await maintainSnapshots(env.DB, hubs, NOW + 3)).toEqual({ status: "idle" });
    // 돌아가는 순서: 앞 거점이 만들 수 없어도(pending) 다음 실행에는 다른 거점이 먼저
    await env.DB.prepare("DELETE FROM hub_snapshots").run();
    await replaceTilePlaces(env.DB, tileKeyOf(HUB), ["8888"], NOW, false);
    expect(await maintainSnapshots(env.DB, hubs, NOW + 4)).toMatchObject({ status: "skipped", hub: "bongeunsa", reason: "pending" });
    expect(await maintainSnapshots(env.DB, [hubs[1], hubs[2], hubs[0]], NOW + 5)).toMatchObject({ status: "built", hub: "ddp" });
  });

  it("R56: 더러운 스냅샷은 SNAPSHOT_DIRTY_REBUILD_MS가 지나면, 깨끗한 스냅샷은 만료 SNAPSHOT_REFRESH_BEFORE_MS 전에 다시 만든다", async () => {
    await freshAll();
    for (let i = 0; i < hubs.length; i++) await maintainSnapshots(env.DB, hubs, NOW + i);
    await env.DB.batch([markHubsDirtyStmt(env.DB, ["ddp"], NOW + 10)]);
    expect(await maintainSnapshots(env.DB, hubs, NOW + SNAPSHOT_DIRTY_REBUILD_MS - 10)).toEqual({ status: "idle" });
    expect(await maintainSnapshots(env.DB, hubs, NOW + SNAPSHOT_DIRTY_REBUILD_MS + 1)).toMatchObject({ status: "built", hub: "ddp" });
    const t = NOW + SNAPSHOT_MAX_AGE_MS - SNAPSHOT_REFRESH_BEFORE_MS;
    expect(await maintainSnapshots(env.DB, hubs, t - 10)).toEqual({ status: "idle" });
    // 가장 오래된 것부터
    expect(await maintainSnapshots(env.DB, hubs, t + 5)).toMatchObject({ status: "built", hub: "bongeunsa" });
  });

  it("R56: Cron 실행 결과에 스냅샷 한 거점의 결과가 실린다 (읽기 예산을 넘은 날에도 만든다)", async () => {
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) await markTile(env.DB, k, NOW, 0, false);
    const local = fakeKakaoLocal([]);
    const r = await runScheduled(env, { fetcher: local.fetcher, now: NOW, sleep: async () => {} });
    expect(r.snapshot).toMatchObject({ status: "built", hub: r.order[0] });
    await env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '99999999')").bind(`d1_read:${utcDay(NOW)}`).run();
    const r2 = await runScheduled(env, { fetcher: local.fetcher, now: NOW + 5 * 60_000, sleep: async () => {} });
    expect(r2.skipped).toBe("read_budget");
    expect(r2.snapshot).toMatchObject({ status: "built" });
  });
});

describe("R56 판과 마이그레이션", () => {
  it("R56: 판 상수 — 응답 형식(PLACES_CACHE_VERSION)·목록 조각(LIST_JSON_VERSION)을 올리면 스냅샷 판도 같이 본다", () => {
    // 주의: 이 셋 중 하나를 바꾸면 나머지도 볼 것 — /api/places 본문이 바뀌면 HUB_SNAPSHOT_VERSION도 올린다
    expect({ cache: PLACES_CACHE_VERSION, list: LIST_JSON_VERSION, snapshot: HUB_SNAPSHOT_VERSION }).toEqual({ cache: "7", list: 1, snapshot: 1 });
  });

  it("R56: 0007은 데이터가 있는 DB에 적용된다 (기존 행은 그대로)", async () => {
    await seedHub();
    await env.DB.prepare("DROP TABLE hub_snapshots").run();
    await env.DB.prepare("DELETE FROM d1_migrations WHERE name LIKE '0007%'").run();
    const places = await env.DB.prepare("SELECT count(*) AS c FROM places").first<{ c: number }>();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await env.DB.prepare("SELECT count(*) AS c FROM places").first<{ c: number }>()).toEqual(places);
    expect(await buildHubSnapshot(env.DB, HUB, NOW)).toMatchObject({ status: "built" });
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('hub_snapshots')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toEqual(["hub", "version", "built_at", "source_at", "encoding", "etag", "body"]);
  });
});
