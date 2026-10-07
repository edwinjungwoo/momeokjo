import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DETAIL_FAIL_TTL_MS, LIST_JSON_VERSION, PREWARM_RADIUS } from "../../shared/constants";
import { tilesCoveringCircle } from "../../shared/geo";
import { HUBS, PUBLIC_HUBS, hubById } from "../../shared/hubs";
import type { FetchFn } from "../../worker/fetchFn";
import { limitsFrom } from "../../worker/config";
import { HUB_SNAPSHOT_VERSION } from "../../worker/hubSnapshot";
import { HUB_DUE_EXISTS_SQL, HUB_REFRESHED_PREFIX } from "../../worker/hubRefresh";
import { hubOrder, runDetailCron, runScheduled, runSnapshotCron } from "../../worker/maintenance";
import { hubRefreshStart } from "../../worker/refreshSchedule";
import {
  EXPIRED_SCAN_SQL, NEAREST_UNFETCHED_SQL, TILES_FRESH_KEY, TILES_FRESH_RECHECK_MS, UNFETCHED_FROM_KEY, UNFETCHED_PROBE_TILES,
  nearestUnfetchedStates, pickCronIds, tilePlaceStates, unfetchedStates,
} from "../../worker/repo";
import { placeJson } from "../helpers/places";
import { recordingDb, type Executed } from "../helpers/recordDb";

/**
 * Task 40: 운영과 같은 크기(거점 8곳, 격자 ≈540칸, 가게 ≈1만 곳)에서 본 Cron·상세만 실행·스냅샷 Cron이 한 번에 읽는 D1 행의 상한.
 * 운영(2026-10-07 07:3x KST)에서 본 Cron은 실행마다 ≈4천 행(격자 확인 ≈1.1천 + 미수집 30칸 묶음 ≈2천 + 만료 쪽 ≈0.9천)을 읽었다
 */
const kst = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
/** 2026-10-07 수요일 12:00 KST — 가장 늦은 갱신 시작(수 00:00)에서 12시간 뒤, 보관 정리 창 밖 */
const NOW = kst(2026, 10, 7, 12);
const MIN5 = 5 * 60_000;
const KEYS = [...new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)))];
const PER_TILE = 20;
const DDP = hubById("ddp");
const BONG = hubById("bongeunsa");
/** 새 거점(준비 중) 격자 — 미수집이 몰린 자리 */
const NEW_HUB_TILES = new Set(HUBS.filter((h) => !h.ready).flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)));
const DDP_TILES = new Set(tilesCoveringCircle(DDP, PREWARM_RADIUS));
const FAILED_ID = `${KEYS.indexOf(tilesCoveringCircle(BONG, PREWARM_RADIUS)[0])}_0`;

const DUETILE_SQL = "WHERE NOT EXISTS (SELECT 1 FROM tiles t";
const reads = (log: Executed[], pred: (sql: string) => boolean = () => true) =>
  log.filter((x) => pred(x.sql)).reduce((n, x) => n + x.read, 0);

type Scenario = "backlog" | "refresh" | "idle";

/**
 * backlog: 새 거점 3곳의 가게는 상세가 없고(미수집 ≈4천), 동대문은 이번 갱신 시작 전에 가져온 ok(갱신 대상), 봉은사에 6시간 지난 실패 1곳.
 * refresh: 미수집 없음, 동대문 갱신 중. idle: 모두 시작 뒤에 가져왔고 모든 거점 완료 기록
 */
async function seed(s: Scenario) {
  const fresh = NOW - 3600_000;
  const ddpOld = hubRefreshStart(DDP, NOW) - 3600_000;
  const tp: [string, string][] = [];
  const places: [string, string, number][] = [];
  KEYS.forEach((k, i) => {
    for (let n = 0; n < PER_TILE; n++) {
      const id = `${i}_${n}`;
      tp.push([k, id]);
      if (s === "backlog" && NEW_HUB_TILES.has(k)) continue;
      const due = s !== "idle" && DDP_TILES.has(k);
      if (s === "backlog" && id === FAILED_ID) places.push([id, "failed", NOW - DETAIL_FAIL_TTL_MS - 1000]);
      else places.push([id, "ok", due ? ddpOld : fresh]);
    }
  });
  for (let i = 0; i < places.length; i += 1000) {
    await env.DB.prepare(
      `INSERT INTO places (id, status, fetched_at, name, category_name, category_group, lat, lng)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), '가게', '음식점 > 한식', 'korean', ?, ?
       FROM json_each(?)`,
    ).bind(BONG.lat, BONG.lng, JSON.stringify(places.slice(i, i + 1000))).run();
  }
  for (let i = 0; i < tp.length; i += 1000) {
    await env.DB.prepare(
      "INSERT INTO tile_places (tile_key, place_id) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)",
    ).bind(JSON.stringify(tp.slice(i, i + 1000))).run();
  }
  await env.DB.prepare(
    "INSERT INTO tiles (key, collected_at, place_count, saturated) SELECT value, ?, ?, 0 FROM json_each(?)",
  ).bind(fresh, PER_TILE, JSON.stringify(KEYS)).run();
  // 갱신을 다 끝낸 거점은 완료 기록이 있다 (운영과 같다 — 거점마다 주 한 번 하는 완료 확인 전체 훑기는 정상 상태가 아니다)
  const done = HUBS.filter((h) => s === "idle" || (h.id !== DDP.id && !(s === "backlog" && !h.ready)));
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, 'done')").bind(`list_json_backfill:v${LIST_JSON_VERSION}`).run();
  {
    await env.DB.batch(done.map((h) =>
      env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
        .bind(HUB_REFRESHED_PREFIX + h.id, JSON.stringify({ start: hubRefreshStart(h, NOW), at: fresh }))));
  }
  return { places: places.length, ids: tp.length };
}

/** 어느 가게든 상세를 돌려주는 가짜 상세 API (좌표는 봉은사) */
function anyPlace() {
  const calls: string[] = [];
  const fetcher: FetchFn = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    calls.push(id);
    return Response.json(placeJson({ name: `가게${id}`, lat: BONG.lat, lng: BONG.lng }));
  };
  return { fetcher, calls };
}

async function mainRun(now: number) {
  const { db, log } = recordingDb(env.DB);
  const place = anyPlace();
  const r = await runScheduled({ ...env, DB: db }, { fetcher: place.fetcher, now, sleep: async () => {} });
  return { r, log, place };
}
async function detailRun(now: number) {
  const { db, log } = recordingDb(env.DB);
  const place = anyPlace();
  const r = await runDetailCron({ ...env, DB: db }, { fetcher: place.fetcher, now, sleep: async () => {} });
  return { r, log, place };
}
/** 미수집 커서 재설정 걷기(540칸 = 30칸 × 6묶음 × 3번)를 지나 정상 상태로: 본 Cron 3번. 다음 실행 시각을 돌려준다 */
async function warmUp(from = NOW): Promise<number> {
  for (let i = 0; i < 3; i++) await mainRun(from + i * MIN5);
  return from + 3 * MIN5;
}
const metaValue = async (key: string) =>
  (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;

describe("Task 40: 운영 크기에서 Cron 한 번이 읽는 D1 행 (정상 상태 상한)", () => {
  it("R38/R11: 운영 크기 픽스처 — 거점 8곳, 격자 ≈540칸, 가게 ≈1만 곳", async () => {
    const n = await seed("idle");
    expect(HUBS).toHaveLength(8);
    expect(KEYS.length).toBeGreaterThan(500);
    expect(n.ids).toBeGreaterThan(10_000);
  });

  it("R38/R11/R63/R9: 새 거점 미수집이 쌓인 동안 본 Cron은 실행마다 ≤1.5천 행 — 격자 확인을 건너뛰고, 미수집은 앞선 자리만 작게 읽고, 미수집이 배치를 다 채우면 ok 만료 쪽은 읽지 않는다 (고르는 가게는 다 읽은 것과 같다)", async () => {
    await seed("backlog");
    // 첫 실행: 격자 확인·미수집 커서 재설정. R9: 미수집이 밀려 있어도 실패 재시도 자리 하나
    expect((await mainRun(NOW)).place.calls).toContain(FAILED_ID);
    const now = await warmUp(NOW + MIN5);
    const okCursor = await metaValue("expired_from:ok");
    // 모든 격자-장소 상태를 읽어 고른 것 (Cron 순서의 기준)
    const B = limitsFrom(env).batchSize; // 운영 배치 (wrangler.jsonc DETAIL_BATCH_SIZE)
    const oracle = pickCronIds(await tilePlaceStates(env.DB, KEYS), hubOrder(HUBS, now), now, B);
    const { r, log, place } = await mainRun(now);
    expect(r).toMatchObject({ failed: 0, batch: B });
    expect(r.d1Skipped).toBeUndefined();
    // 글자 예산(200,000자)이 배치 뒤쪽을 남길 수 있다 — 가져온 것은 고른 순서의 앞쪽, 나머지는 deferred
    expect(r.enriched + (r.deferred ?? 0)).toBe(B);
    expect([...place.calls].sort()).toEqual(oracle.slice(0, place.calls.length).sort());
    // 단계별 상한
    expect(log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(false);
    expect(reads(log, (q) => q === NEAREST_UNFETCHED_SQL)).toBeLessThanOrEqual(600);
    expect(reads(log, (q) => q === EXPIRED_SCAN_SQL)).toBeLessThanOrEqual(20);
    expect(reads(log, (q) => q === HUB_DUE_EXISTS_SQL)).toBeLessThanOrEqual(100);
    expect(await metaValue("expired_from:ok")).toBe(okCursor); // ok 커서는 그대로 (다음에 읽을 때 잇는다)
    expect(reads(log), `main reads ${reads(log)}`).toBeLessThanOrEqual(1500);
    // 상세만 실행도 같은 단계를 쓴다
    const d = await detailRun(now + 60_000);
    // 운영 배치·글자 예산 그대로 — 가져온 곳 + 글자 예산으로 남긴 곳 = 배치
    expect(d.r.enriched + (d.r.deferred ?? 0)).toBe(B);
    expect(reads(d.log), `detail reads ${reads(d.log)}`).toBeLessThanOrEqual(1500);
  });

  it("R38/R63: 주간 갱신 중(미수집 없음) 본 Cron·상세만 실행은 실행마다 ≤1.5천 행 — 미수집 커서는 끝이라 묶음 질의가 없고 만료 쪽 하나", async () => {
    await seed("refresh");
    const now = await warmUp();
    const B = limitsFrom(env).batchSize;
    const { r, log } = await mainRun(now);
    expect(r).toMatchObject({ failed: 0 });
    expect(r.enriched + (r.deferred ?? 0)).toBe(B);
    expect(log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(false);
    expect(log.some((x) => x.sql === NEAREST_UNFETCHED_SQL)).toBe(false);
    expect(reads(log, (q) => q === EXPIRED_SCAN_SQL)).toBeLessThanOrEqual(1000);
    expect(reads(log), `main reads ${reads(log)}`).toBeLessThanOrEqual(1500);
    const d = await detailRun(now + 60_000);
    expect(d.r.enriched + (d.r.deferred ?? 0)).toBe(B);
    expect(reads(d.log), `detail reads ${reads(d.log)}`).toBeLessThanOrEqual(1500);
  });

  it("R38: 할 일이 없을 때 본 Cron은 실행마다 ≤150행, 상세만 실행은 ≤100행", async () => {
    await seed("idle");
    const now = await warmUp();
    const { r, log } = await mainRun(now);
    expect(r).toMatchObject({ enriched: 0, tiles: { collected: 0 } });
    expect(reads(log), `main reads ${reads(log)}`).toBeLessThanOrEqual(150);
    const d = await detailRun(now + 60_000);
    expect(reads(d.log), `detail reads ${reads(d.log)}`).toBeLessThanOrEqual(100);
  });

  it("R38/R56: 할 일이 없는 스냅샷 Cron은 ≤100행 (스냅샷 메타·표시만)", async () => {
    await seed("idle");
    await env.DB.batch(PUBLIC_HUBS.map((h) =>
      env.DB.prepare(
        "INSERT INTO hub_snapshots (hub, version, built_at, source_at, encoding, etag, body) VALUES (?, ?, ?, 0, 'gzip', ?, 'x')",
      ).bind(h.id, HUB_SNAPSHOT_VERSION, NOW - 10 * 60_000, `"e-${h.id}"`)));
    const { db, log } = recordingDb(env.DB);
    expect(await runSnapshotCron({ ...env, DB: db }, { now: NOW })).toEqual({ status: "idle" });
    expect(reads(log), `snapshot reads ${reads(log)}`).toBeLessThanOrEqual(100);
  });
});

describe("Task 40: 본 Cron 격자 확인 표시 (tiles_fresh)", () => {
  it("R11/R63/R38: 수집할 격자가 없다고 확인하면 표시를 남기고 다음 실행은 격자 확인을 건너뛴다 — 한 시간이 지나거나 거점 갱신 시작이 지나면 다시 확인한다", async () => {
    await seed("idle");
    const first = await mainRun(NOW);
    expect(first.log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(true);
    expect(JSON.parse((await metaValue(TILES_FRESH_KEY))!)).toMatchObject({ at: NOW });
    const second = await mainRun(NOW + MIN5);
    expect(second.log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(false);
    // 한 시간 뒤에는 다시 확인한다 (손으로 고친 tiles 행 같은 드문 일)
    const later = await mainRun(NOW + TILES_FRESH_RECHECK_MS);
    expect(later.log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(true);
    // R63: 목요일 00:00 KST(정부과천청사·광화문 갱신 시작)가 지나면 그 거점 격자가 수집 대상이다 — 표시가 젊어도 다시 확인해 모은다
    const thu = kst(2026, 10, 8, 0, 5);
    await env.DB.prepare("UPDATE meta SET value = ? WHERE key = ?").bind(JSON.stringify({ ...JSON.parse((await metaValue(TILES_FRESH_KEY))!), at: thu - MIN5 }), TILES_FRESH_KEY).run();
    const local = anyPlace(); // 로컬 검색은 빈 결과
    const { db, log } = recordingDb(env.DB);
    const r = await runScheduled({ ...env, DB: db }, {
      fetcher: async (input, init) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        return u.hostname === "dapi.kakao.com"
          ? Response.json({ meta: { total_count: 0, pageable_count: 0, is_end: true }, documents: [] })
          : local.fetcher(input, init);
      },
      now: thu, sleep: async () => {},
    });
    expect(log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(true);
    expect(r.tiles.collected + r.tiles.incomplete).toBeGreaterThan(0);
    // 다 모으지 못했으면 표시를 새로 쓰지 않는다 — 다음 실행도 확인한다
    if (r.tiles.incomplete > 0) {
      expect(JSON.parse((await metaValue(TILES_FRESH_KEY))!).at).toBe(thu - MIN5);
      const next = await mainRun(thu + MIN5);
      expect(next.log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(true);
    }
  });

  it("R11: 표시가 젊어도 격자 집합이 바뀌면(거점 추가 등) 다시 확인한다 — 표시 지문이 격자와 기준 시각을 담는다", async () => {
    await seed("idle");
    await mainRun(NOW);
    const { db, log } = recordingDb(env.DB);
    await runScheduled({ ...env, DB: db }, { fetcher: anyPlace().fetcher, now: NOW + MIN5, sleep: async () => {}, hubs: HUBS.slice(0, 5) });
    expect(log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(true);
  });
});

describe("Task 40: 미수집 앞선 자리 작게 읽기", () => {
  /** 순위 순서대로 칸을 늘어놓고, 앞쪽 칸은 상세 있음, from번째 칸부터 미수집 */
  async function seedDense(hubs: typeof HUBS, from: number, perTile = 10) {
    const keys = [...new Set(hubs.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)))];
    const states = await (async () => {
      const ranked = [...keys].sort((a, b) => dist(a, hubs) - dist(b, hubs) || (a < b ? -1 : 1));
      return ranked;
    })();
    const tp: [string, string][] = [];
    const ok: string[] = [];
    states.forEach((k, i) => {
      for (let n = 0; n < perTile; n++) {
        const id = `d${i}_${n}`;
        tp.push([k, id]);
        if (i < from) ok.push(id);
      }
    });
    for (let i = 0; i < ok.length; i += 1000) {
      await env.DB.prepare("INSERT INTO places (id, status, fetched_at) SELECT value, 'ok', ? FROM json_each(?)")
        .bind(NOW, JSON.stringify(ok.slice(i, i + 1000))).run();
    }
    for (let i = 0; i < tp.length; i += 1000) {
      await env.DB.prepare(
        "INSERT INTO tile_places (tile_key, place_id) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)",
      ).bind(JSON.stringify(tp.slice(i, i + 1000))).run();
    }
    return { keys, ranked: states };
  }
  const dist = (k: string, hubs: typeof HUBS) => {
    const [i, j] = k.split(":").map(Number);
    return Math.min(...hubs.map((h) => Math.hypot(i - h.lat / 0.00225, j - h.lng / 0.0028)));
  };
  const oracle = async (keys: string[], hubs: typeof HUBS, limit: number) =>
    pickCronIds(await unfetchedStates(env.DB, keys), hubs, NOW, limit);
  const run = async (keys: string[], hubs: typeof HUBS, limit = 4) => {
    const { db, log } = recordingDb(env.DB);
    const r = await nearestUnfetchedStates(db, keys, hubs, limit);
    return { ids: r.states.map((t) => t.id), cleared: r.cleared, read: reads(log, (q) => q === NEAREST_UNFETCHED_SQL), log };
  };

  it("R11/R38: 지난 실행이 커서 자리에서 미수집을 찾았으면(hit) 다음 실행은 그 자리의 작은 묶음만 읽는다 — 고르는 가게는 미수집 전부에서 고른 것과 같다", async () => {
    const { keys } = await seedDense(HUBS, 100);
    const first = await run(keys, HUBS);
    expect(first.ids).toEqual(await oracle(keys, HUBS, 4));
    expect(JSON.parse((await metaValue(UNFETCHED_FROM_KEY))!)).toMatchObject({ hit: true });
    const second = await run(keys, HUBS);
    expect(second.ids).toEqual(first.ids);
    expect(second.log.filter((x) => x.sql === NEAREST_UNFETCHED_SQL)).toHaveLength(1);
    // 작은 묶음(UNFETCHED_PROBE_TILES[0]칸쯤) × 칸마다 10곳 × (격자-장소 + 가게) 정도
    expect(second.read).toBeLessThan(first.read / 3);
    expect(second.read).toBeLessThanOrEqual(UNFETCHED_PROBE_TILES[0] * 4 * 10 * 2 + 50);
  });

  it("R11: hit 자리의 미수집이 다 채워져도 같은 실행에서 작은 묶음을 늘려 가며 다음 미수집을 찾고, 예전처럼 30칸 묶음 6개까지 이어 읽는다 (한 실행이 읽는 칸은 줄지 않는다)", async () => {
    const { keys, ranked } = await seedDense(HUBS, 100);
    await run(keys, HUBS);
    // 앞선 자리부터 300칸 가까이를 채운다 — 다음 미수집은 작은 묶음 합(30칸)보다 훨씬 뒤
    const fill = ranked.slice(100, 290).flatMap((k, i) => Array.from({ length: 10 }, (_, n) => `d${100 + i}_${n}`));
    for (let i = 0; i < fill.length; i += 1000) {
      await env.DB.prepare("INSERT INTO places (id, status, fetched_at) SELECT value, 'ok', ? FROM json_each(?)")
        .bind(NOW, JSON.stringify(fill.slice(i, i + 1000))).run();
    }
    expect(ranked.length).toBeGreaterThan(290);
    const r = await run(keys, HUBS);
    expect(r.ids).toEqual(await oracle(keys, HUBS, 4));
    expect(r.ids.length).toBe(4);
  });
});
