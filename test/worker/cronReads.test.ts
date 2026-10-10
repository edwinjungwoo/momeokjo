import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DETAIL_FAIL_TTL_MS, LIST_JSON_VERSION, PREWARM_RADIUS } from "../../shared/constants";
import { haversine, tileRect, tilesCoveringCircle } from "../../shared/geo";
import { HUBS, PUBLIC_HUBS, hubById } from "../../shared/hubs";
import type { FetchFn } from "../../worker/fetchFn";
import { limitsFrom } from "../../worker/config";
import { HUB_SNAPSHOT_VERSION } from "../../worker/hubSnapshot";
import { HUB_DUE_EXISTS_SQL, HUB_REFRESHED_PREFIX } from "../../worker/hubRefresh";
import { hubOrder, runDetailCron, runScheduled, runSnapshotCron } from "../../worker/maintenance";
import { hubTiles } from "../../worker/hubTiles";
import { hubRefreshStart } from "../../worker/refreshSchedule";
import {
  EXPIRED_DUE_SCAN_SQL, EXPIRED_RESET_PAGES, EXPIRED_SCAN_LIMIT, EXPIRED_SCAN_SQL, NEAREST_UNFETCHED_SQL, TILES_FRESH_KEY, TILES_FRESH_RECHECK_MS, UNFETCHED_CHUNK_TILES, UNFETCHED_FROM_KEY,
  UNFETCHED_MAX_CHUNKS, UNFETCHED_PROBE_TILES,
  nearestUnfetchedStates, pickCronIds, tileDistance, tilePlaceStates, tileSetFingerprint, unfetchedStates,
} from "../../worker/repo";
import { placeJson } from "../helpers/places";
import { recordingDb, type Executed } from "../helpers/recordDb";

/**
 * Task 40: 운영과 같은 크기(거점 14곳, 격자 ≈670칸, 가게 ≈1.4만 곳 — 2026-10-08 역삼역·선정릉역 추가 전에는 8곳·540칸, 2026-10-09 선릉역·삼성역 추가 전에는 10곳·599칸, 시청역·을지로입구역 추가 전에는 12곳·631칸)에서 본 Cron·상세만 실행·스냅샷 Cron이 한 번에 읽는 D1 행의 상한.
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
/** 새 거점 — 2026-10-06에 더해 미수집이 몰렸던 3곳 (2026-10-08 공개 뒤에도 같은 자리로 새 거점 미수집을 흉내 낸다. 공개 여부와 무관) */
const NEW_HUB_IDS = new Set(["gangnam", "yeouido", "gwanghwamun"]);
/** 새 거점 격자 — 미수집이 몰린 자리 */
const NEW_HUB_TILES = new Set(HUBS.filter((h) => NEW_HUB_IDS.has(h.id)).flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)));
const DDP_TILES = new Set(tilesCoveringCircle(DDP, PREWARM_RADIUS));
const FAILED_ID = `${KEYS.indexOf(tilesCoveringCircle(BONG, PREWARM_RADIUS)[0])}_0`;

const DUETILE_SQL = "WHERE NOT EXISTS (SELECT 1 FROM tiles t";
/** 만료 후보 조회 — R66 뒤 ok는 (status, due_after), 실패는 (status, fetched_at) */
const isExpiredScan = (q: string) => q === EXPIRED_SCAN_SQL || q === EXPIRED_DUE_SCAN_SQL;
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
    // R66: 운영 행은 0008 적용 때 due_after = fetched_at으로 채워졌다 (모두 주기 1 — 예전과 같은 대상)
    await env.DB.prepare(
      `INSERT INTO places (id, status, fetched_at, due_after, name, category_name, category_group, lat, lng)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[2]'),
         '가게', '음식점 > 한식', 'korean', ?, ?
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
  const done = HUBS.filter((h) => s === "idle" || (h.id !== DDP.id && !(s === "backlog" && NEW_HUB_IDS.has(h.id))));
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
/** 미수집 커서 재설정 걷기 — 실행마다 30칸 × 6묶음씩이라 669칸이면 4번 (540칸일 때는 3번) */
const WALK_RUNS = Math.ceil(KEYS.length / (UNFETCHED_CHUNK_TILES * UNFETCHED_MAX_CHUNKS));
/** 미수집 커서 재설정 걷기를 지나 정상 상태로: 본 Cron WALK_RUNS번. 다음 실행 시각을 돌려준다 */
async function warmUp(from = NOW): Promise<number> {
  for (let i = 0; i < WALK_RUNS; i++) await mainRun(from + i * MIN5);
  return from + WALK_RUNS * MIN5;
}
const metaValue = async (key: string) =>
  (await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;

describe("Task 40: 운영 크기에서 Cron 한 번이 읽는 D1 행 (정상 상태 상한)", () => {
  it("R38/R11: 운영 크기 픽스처 — 거점 14곳(모두 공개), 격자 669칸(겹친 칸은 한 번), 가게 ≈1.2만 곳", async () => {
    const n = await seed("idle");
    expect(HUBS).toHaveLength(14);
    expect(PUBLIC_HUBS).toHaveLength(14);
    expect(KEYS).toHaveLength(669);
    expect(WALK_RUNS).toBe(4);
    expect(n.ids).toBe(669 * PER_TILE);
  });

  it("R38/R11/R63/R9: 새 거점 미수집이 쌓인 동안 본 Cron은 실행마다 ≤1.5천 행 — 격자 확인을 건너뛰고, 미수집은 앞선 자리만 작게 읽고, 미수집이 배치를 다 채우면 ok 만료 쪽은 읽지 않는다 (고르는 가게는 다 읽은 것과 같다)", async () => {
    expect(NEW_HUB_TILES.size).toBeGreaterThan(0);
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
    expect(reads(log, isExpiredScan)).toBeLessThanOrEqual(20);
    expect(reads(log, (q) => q === HUB_DUE_EXISTS_SQL)).toBeLessThanOrEqual(100);
    expect(await metaValue("expired_from:ok")).toBe(okCursor); // ok 커서는 그대로 (다음에 읽을 때 잇는다)
    expect(reads(log), `main reads ${reads(log)}`).toBeLessThanOrEqual(1500);
    // 상세만 실행도 같은 단계를 쓴다
    const d = await detailRun(now + 60_000);
    // 운영 배치·글자 예산 그대로 — 가져온 곳 + 글자 예산으로 남긴 곳 = 배치
    expect(d.r.enriched + (d.r.deferred ?? 0)).toBe(B);
    expect(reads(d.log), `detail reads ${reads(d.log)}`).toBeLessThanOrEqual(1500);
  });

  it("R38/R11: 운영 배치(DETAIL_BATCH_SIZE 4)의 보통 실행은 넉넉한 실행이다 — 미수집을 먼저 읽고 만료 후보는 그 뒤에만, 격자 확인·표시 쓰기·list_json 백필이 다 있는 실행(여유가 가장 적다)도 (여유가 줄어 빠듯한 순서로 바뀌면 여기서 알린다)", async () => {
    expect(limitsFrom(env).batchSize).toBe(4);
    await seed("backlog");
    // list_json 백필이 아직 남은 운영 상태 (백필 커서 읽기 + 행 읽기 + 쓰기)
    await env.DB.prepare("DELETE FROM meta WHERE key LIKE 'list_json_backfill:%'").run();
    await env.DB.prepare("UPDATE places SET list_json = NULL WHERE rowid IN (SELECT rowid FROM places LIMIT 5)").run();
    const order = (log: Executed[]) => {
      const unfetched = log.findIndex((x) => x.sql === NEAREST_UNFETCHED_SQL);
      const expired = log.findIndex((x) => isExpiredScan(x.sql));
      return { unfetched, expired };
    };
    // 첫 실행: 격자 확인 + 수집할 격자 없음 표시 쓰기 + 백필 + 미수집 커서 재설정
    const first = await mainRun(NOW);
    expect(first.log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(true);
    expect(first.r.listJsonFilled).toBeGreaterThan(0);
    expect(first.r.d1Skipped).toBeUndefined();
    const o1 = order(first.log);
    expect(o1.unfetched).toBeGreaterThanOrEqual(0);
    expect(o1.expired === -1 || o1.unfetched < o1.expired, JSON.stringify(o1)).toBe(true);
    // 보통 실행
    const now = await warmUp(NOW + MIN5);
    const { r, log } = await mainRun(now);
    expect(r.d1Skipped).toBeUndefined();
    const o = order(log);
    expect(o.unfetched).toBeGreaterThanOrEqual(0);
    expect(o.expired === -1 || o.unfetched < o.expired, JSON.stringify(o)).toBe(true);
  });

  it("R38/R63: 주간 갱신 중(미수집 없음) 본 Cron은 실행마다 ≤600행·상세만 실행은 ≤550행 — 미수집 커서는 끝이라 묶음 질의가 없고 만료 쪽 하나(≤350행) (Task 58: 쪽 300 → 100행으로 본 Cron 1,070 → 470행·상세만 1,032 → 432행, 만료 쪽 902 → 302행)", async () => {
    await seed("refresh");
    const now = await warmUp();
    const B = limitsFrom(env).batchSize;
    const { r, log } = await mainRun(now);
    expect(r).toMatchObject({ failed: 0 });
    expect(r.enriched + (r.deferred ?? 0)).toBe(B);
    expect(log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(false);
    expect(log.some((x) => x.sql === NEAREST_UNFETCHED_SQL)).toBe(false);
    expect(reads(log, isExpiredScan)).toBeLessThanOrEqual(350);
    expect(reads(log), `main reads ${reads(log)}`).toBeLessThanOrEqual(600);
    const d = await detailRun(now + 60_000);
    expect(d.r.enriched + (d.r.deferred ?? 0)).toBe(B);
    expect(reads(d.log, isExpiredScan)).toBeLessThanOrEqual(350);
    expect(reads(d.log), `detail reads ${reads(d.log)}`).toBeLessThanOrEqual(550);
  });

  it("R63/R38/R11: 재설정 뒤 만료 커서는 대상 앞의 거점 밖 오래된 ok 행(운영 어림 ≤ 2천 — 가게 ≈1.6만 − 거점 격자 ≈1.4만)을 실행마다 ~300행씩 지나 7번째 상세만 실행에서 대상을 찾는다 — 그동안 실행마다 ≤ 900행(측정 ~620행) (Task 58: 쪽 100행. 예전 300행 쪽은 3번째 실행·실행당 ~1.8천 행 — 지나가는 읽기 합은 ~3.6천 행으로 같다)", async () => {
    expect(EXPIRED_SCAN_LIMIT).toBe(100);
    expect(EXPIRED_RESET_PAGES).toBe(3);
    await seed("refresh");
    // 거점 밖 오래된 ok 행 (예전 warm의 ASEM 1500m 고리 — 격자 밖 칸, 공유 링크 단건 조회 — 격자 없음). Cron이 갱신하지 않아 due_after가
    // 언제나 인덱스 맨 앞이다. 동대문 대상(ddpOld)보다 앞
    const N_OUT = 2000;
    const outside = Array.from({ length: N_OUT }, (_, i) => [`out${i}`, NOW - 30 * 24 * 3600_000 + i] as const);
    for (let i = 0; i < outside.length; i += 500) {
      await env.DB.prepare(
        `INSERT INTO places (id, status, fetched_at, due_after, name, category_name, category_group, lat, lng)
         SELECT json_extract(value, '$[0]'), 'ok', json_extract(value, '$[1]'), json_extract(value, '$[1]'), '가게', '음식점 > 한식', 'korean', ?, ?
         FROM json_each(?)`,
      ).bind(BONG.lat, BONG.lng, JSON.stringify(outside.slice(i, i + 500))).run();
    }
    const tiled = outside.filter((_, i) => i % 2 === 0).map(([id]) => ["1:1", id]);
    for (let i = 0; i < tiled.length; i += 500) {
      await env.DB.prepare("INSERT INTO tile_places (tile_key, place_id) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)")
        .bind(JSON.stringify(tiled.slice(i, i + 500))).run();
    }
    await warmUp();
    // 목요일 00:00 KST(정부과천청사·광화문·시청·을지로입구 갱신 시작) — ok 커서 지문이 바뀌어 처음부터 다시 읽는다 (하루 한 번 있는 재설정)
    const thu = kst(2026, 10, 8, 0, 1);
    const runs: { enriched: number; reads: number; expired: number }[] = [];
    for (let i = 0; i < 10 && !runs.some((x) => x.enriched > 0); i++) {
      const d = await detailRun(thu + i * 60_000);
      runs.push({ enriched: d.place.calls.length, reads: reads(d.log), expired: reads(d.log, isExpiredScan) });
    }
    // 실행마다 새로 지나는 행: 첫 실행 100 + 99 + 99 = 298(쪽마다 마지막 행부터 포함해 잇는다), 다음부터 297 →
    // 대상(N_OUT + 1번째 행)은 1 + ⌈(2001 − 298) / 297⌉ = 7번째 실행
    expect(runs.map((x) => x.enriched > 0)).toEqual([false, false, false, false, false, false, true]);
    for (const x of runs) {
      expect(x.expired, JSON.stringify(runs)).toBeLessThanOrEqual(3 * EXPIRED_RESET_PAGES * EXPIRED_SCAN_LIMIT + 20);
      expect(x.reads, JSON.stringify(runs)).toBeLessThanOrEqual(900);
    }
    // 찾은 뒤에는 커서가 첫 대상 행이라 지나간 행을 다시 읽지 않는다
    const steady = await detailRun(thu + 10 * 60_000);
    expect(steady.place.calls.length).toBeGreaterThan(0);
    expect(reads(steady.log, isExpiredScan)).toBeLessThanOrEqual(3 * EXPIRED_SCAN_LIMIT + 20);
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

  it.each(["backlog", "refresh", "idle"] as const)(
    "R38/R10/R63: %s — 상세만 실행은 meta를 한 번만 읽고(오늘 읽기·쿨다운·frozen·tiles_changed_at·미수집·만료 커서) 보충은 쿨다운을 다시 읽지 않는다 — D1 호출 ≤ 7번(전 11~13번). 본 Cron은 시작(오늘 읽기·격자 확인 표시·백필 커서)과 격자 수집 뒤(쿨다운·완료 기록·커서·집계) 두 번 — ≤ 7번(전 13~14번). 빈 범위만 읽은 만료 커서는 다시 쓰지 않는다 (Task 57)",
    async (s) => {
      await seed(s);
      const now = await warmUp(s === "backlog" ? NOW + MIN5 : NOW);
      const metaReads = (log: Executed[]) => log.filter((x) => /^SELECT (key, )?value FROM meta\b/.test(x.sql)).length;
      const m = await mainRun(now);
      expect(m.r.d1Skipped).toBeUndefined();
      expect(metaReads(m.log), JSON.stringify(m.log.map((x) => x.sql.slice(0, 60)))).toBe(2);
      expect(m.r.d1Calls).toBeLessThanOrEqual(7);
      const d = await detailRun(now + 60_000);
      expect(metaReads(d.log), JSON.stringify(d.log.map((x) => x.sql.slice(0, 60)))).toBe(1);
      expect(d.r.d1Calls).toBeLessThanOrEqual(7);
      if (s !== "idle") expect(d.r.enriched + (d.r.deferred ?? 0)).toBe(limitsFrom(env).batchSize);
    },
  );

  it.each([
    ["backlog", 50],
    ["refresh", 110],
    ["idle", 0],
  ] as const)(
    "R38/R56: %s — 실행의 meta 읽기는 키마다 기본 키로(본 Cron ≤ 50행·상세만 ≤ 12행 — json_each 목록은 71~76·17~18행이었다), 상세 저장의 스냅샷 표시 문장은 저장 전 좌표의 거점을 한 번만 구한다(실행당 ≤ %i행 — 거점마다 가게를 다시 찾아 backlog 88·refresh 136행이었다) (Task 57)",
    async (s, dirtyMax) => {
      await seed(s);
      const now = await warmUp(s === "backlog" ? NOW + MIN5 : NOW);
      const isMeta = (q: string) => /^SELECT (key, )?value FROM meta\b/.test(q);
      const isDirty = (q: string) => q.includes("'snapshot_dirty:' || json_extract(h.value");
      const m = await mainRun(now);
      const d = await detailRun(now + 60_000);
      expect(reads(m.log, isMeta), "main meta").toBeLessThanOrEqual(50);
      expect(reads(d.log, isMeta), "detail meta").toBeLessThanOrEqual(12);
      for (const { log } of [m, d]) {
        expect(reads(log, isDirty), "dirty").toBeLessThanOrEqual(dirtyMax);
        // 저장 묶음(첫 곳 혼자 + 3곳)마다 표시 한 문장 그대로
        expect(log.filter((x) => isDirty(x.sql)).length).toBe(dirtyMax === 0 ? 0 : 2);
      }
    },
  );

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

describe("Task 57: 실행마다 다시 계산하던 격자 값 (새 isolate의 Cron CPU)", () => {
  it("R11/R63: 거점 격자(PREWARM_RADIUS)는 좌표마다 isolate에서 한 번 계산해 같은(바꿀 수 없는) 배열을 돌려주고 tilesCoveringCircle과 같다 — 좌표가 다르면 따로", () => {
    for (const h of HUBS) {
      const a = hubTiles(h);
      expect(a).toEqual(tilesCoveringCircle(h, PREWARM_RADIUS));
      expect(hubTiles({ ...h })).toBe(a);
      expect(Object.isFrozen(a)).toBe(true);
    }
    const moved = { ...BONG, lat: BONG.lat + 0.01 };
    expect(hubTiles(moved)).toEqual(tilesCoveringCircle(moved, PREWARM_RADIUS));
    expect(hubTiles(moved)).not.toEqual(hubTiles(BONG));
  });

  it("R11/R63: 칸에서 가장 가까운 거점까지 거리(순위·Cron 순서의 기준)는 거점마다 haversine의 최솟값과 같은 값이다", () => {
    for (const hubs of [HUBS, hubOrder(HUBS, NOW + MIN5), [BONG], [DDP, BONG]]) {
      for (const k of KEYS) {
        const r = tileRect(k);
        const mid = { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 };
        expect(tileDistance(k, hubs)).toBe(Math.min(...hubs.map((h) => haversine(h, mid))));
      }
    }
    expect(tileDistance(KEYS[0], [])).toBe(Infinity);
  });

  it("R11/R38: 격자 집합 지문은 같은 내용을 다시 받아도 같은 값이고(순서·중복 무관), 내용이 바뀌면 다르다", () => {
    const fp = tileSetFingerprint(KEYS);
    expect(fp).toMatch(/^669:[0-9a-f]+$/);
    expect(tileSetFingerprint([...KEYS])).toBe(fp);
    expect(tileSetFingerprint([...KEYS].reverse())).toBe(fp);
    expect(tileSetFingerprint([...KEYS, KEYS[0]])).toBe(fp);
    expect(tileSetFingerprint(KEYS.slice(1))).not.toBe(fp);
    expect(tileSetFingerprint(KEYS)).toBe(fp);
    expect(tileSetFingerprint(new Set(KEYS))).toBe(fp);
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
    expect(r.tiles.collected).toBeGreaterThan(0);
    // 두 거점 격자는 한 실행의 D1 호출 예산(격자마다 2번)보다 많다 — 다 모으지 못했으니 표시를 새로 쓰지 않고 다음 실행도 확인한다
    expect(r.tiles.incomplete).toBeGreaterThan(0);
    expect(JSON.parse((await metaValue(TILES_FRESH_KEY))!).at).toBe(thu - MIN5);
    const next = await mainRun(thu + MIN5);
    expect(next.log.some((x) => x.sql.includes(DUETILE_SQL))).toBe(true);
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
  /** 칸 순위와 같은 거리 — 가장 가까운 거점에서 칸 중심까지 (repo.ts tileDistance·rankGroups와 같은 값) */
  const dist = (k: string, hubs: typeof HUBS) => {
    const r = tileRect(k);
    const mid = { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 };
    return Math.min(...hubs.map((h) => haversine(h, mid)));
  };
  const oracle = async (keys: string[], hubs: typeof HUBS, limit: number) =>
    pickCronIds(await unfetchedStates(env.DB, keys), hubs, NOW, limit);
  const run = async (keys: string[], hubs: typeof HUBS, limit = 4, maxQueries?: number) => {
    const { db, log } = recordingDb(env.DB);
    const r = await nearestUnfetchedStates(db, keys, hubs, limit, { maxQueries });
    return { ids: r.states.map((t) => t.id), cleared: r.cleared, read: reads(log, (q) => q === NEAREST_UNFETCHED_SQL), log };
  };
  /** 앞선 자리(ranked 100번째부터)의 미수집을 290번째 앞까지 채운다 — 다음 미수집은 작은 묶음 합(30칸)보다 훨씬 뒤 */
  async function drainHitArea(ranked: string[]) {
    const fill = ranked.slice(100, 290).flatMap((k, i) => Array.from({ length: 10 }, (_, n) => `d${100 + i}_${n}`));
    for (let i = 0; i < fill.length; i += 1000) {
      await env.DB.prepare("INSERT INTO places (id, status, fetched_at) SELECT value, 'ok', ? FROM json_each(?)")
        .bind(NOW, JSON.stringify(fill.slice(i, i + 1000))).run();
    }
    expect(ranked.length).toBeGreaterThan(290);
  }

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
    await drainHitArea(ranked);
    const r = await run(keys, HUBS);
    expect(r.ids).toEqual(await oracle(keys, HUBS, 4));
    expect(r.ids.length).toBe(4);
  });

  it("R11/R38: D1 호출이 빠듯한 실행(maxQueries 8)은 작은 묶음도 질의를 써서 hit 자리가 다 채워졌으면 이번에는 덜 걷는다 — 커서는 읽은 데까지 나아가고 hit가 풀려, 다음 빠듯한 실행이 큰 묶음으로 이어 찾는다 (빠뜨리지 않고 한 실행 늦을 뿐)", async () => {
    const { keys, ranked } = await seedDense(HUBS, 100);
    await run(keys, HUBS, 4, 8);
    expect(JSON.parse((await metaValue(UNFETCHED_FROM_KEY))!)).toMatchObject({ hit: true });
    await drainHitArea(ranked);
    const want = await oracle(keys, HUBS, 4);
    expect(want).toHaveLength(4);
    // 이번 실행: 작은 묶음 4개(2·4·8·16칸) + 30칸 묶음 2개 = 질의 6개(8 − 커서 읽기·쓰기)로는 190칸 뒤까지 닿지 않는다
    const first = await run(keys, HUBS, 4, 8);
    expect(first.log.filter((x) => x.sql === NEAREST_UNFETCHED_SQL)).toHaveLength(6);
    expect(first.ids).toEqual([]);
    expect(first.cleared).toBe(false);
    const cursor = JSON.parse((await metaValue(UNFETCHED_FROM_KEY))!);
    expect(cursor.hit).toBeUndefined();
    // 다음 빠듯한 실행: hit가 풀려 30칸 묶음부터 — 찾는다
    const second = await run(keys, HUBS, 4, 8);
    expect(second.ids).toEqual(want);
  });
});
