import { PREWARM_RADIUS } from "../shared/constants";
import { tilesCoveringCircle } from "../shared/geo";
import { HUBS, type Hub } from "../shared/hubs";
import type { LatLng } from "../shared/types";
import { Budget } from "./budget";
import { limitsFrom } from "./config";
import { meteredDb, overReadBudget, readSoftCap, recordCronRun, recordD1Usage, type D1Usage } from "./d1Usage";
import { enrichDetails } from "./detailEnricher";
import { isRetentionWindow, pruneOldEvents } from "./events";
import { pruneRollups, runRollups } from "./rollup";
import type { FetchFn } from "./fetchFn";
import { maintainSnapshots, type SnapshotRun } from "./hubSnapshot";
import {
  backfillListJson, countNeedingDetail, detailGate, detailsAllowed, expiredDetailStates, markUnfetchedCleared,
  nearestUnfetchedStates, tilesChangedAt, unfetchedClearedAt, type TilePlaceState,
} from "./repo";
import { collectTiles } from "./tileCollector";

export type WarmDeps = {
  db: D1Database;
  fetcher: FetchFn;
  restKey: string;
  budgetSize: number;
  batchSize: number;
  /** Task 34: 한 번에 풀 상세 JSON 글자 수 (없으면 기본값) */
  detailCharBudget?: number;
  now: number;
  sleep?: (ms: number) => Promise<void>;
};
/** pending: 남은 상세 수. 세지 않을 때는 0(끝) 또는 "more"(더 있을 수 있음) */
export type WarmResult = { incompleteTiles: number; pending: number | "more"; enriched: number; failed: number };

/**
 * R31: 한 번 수집·보충한다. 남은 수(pending)를 세려고 격자 전체를 다시 훑지 않는다(R38) —
 * 이번에 고른 상세가 배치를 다 채우지 못했고 예산·쿨다운으로 멈추지 않았으면 남은 것이 없다.
 * opts.count면 예전처럼 정확히 센다(전체 스캔, 명시적으로 요청할 때만).
 */
export async function warmOnce(
  deps: WarmDeps, center: LatLng, radiusM: number, opts: { count?: boolean } = {},
): Promise<WarmResult> {
  const budget = new Budget(deps.budgetSize);
  const tiles = await collectTiles(
    { db: deps.db, fetcher: deps.fetcher, restKey: deps.restKey, budget, now: deps.now },
    tilesCoveringCircle(center, radiusM),
  );
  const e = await enrichDetails(
    {
      db: deps.db, fetcher: deps.fetcher, budget, now: deps.now, batchSize: deps.batchSize, sleep: deps.sleep,
      charBudget: deps.detailCharBudget,
    },
    center,
    radiusM,
  );
  let pending: WarmResult["pending"];
  if (opts.count) pending = await countNeedingDetail(deps.db, center, radiusM, deps.now);
  else {
    // 글자 예산으로 남긴 곳(deferred)이 있으면 끝나지 않았다
    const done =
      e.enriched + e.failed < deps.batchSize && e.deferred === 0 && budget.left > 0 &&
      detailsAllowed(await detailGate(deps.db), deps.now);
    pending = done ? 0 : "more";
  }
  return { incompleteTiles: tiles.incomplete.length + tiles.failed.length, pending, enriched: e.enriched, failed: e.failed };
}

// Cron 주기: wrangler.jsonc의 5분 간격 스케줄과 맞춘다
export const CRON_INTERVAL_MS = 5 * 60_000;

/** 실행마다 시작 거점을 하나씩 돌린다 — 앞 거점이 예산을 다 써도 다음 실행에는 다른 거점이 먼저 쓴다 */
export function hubOrder(hubs: Hub[], now: number): Hub[] {
  if (hubs.length === 0) return [];
  const start = Math.floor(now / CRON_INTERVAL_MS) % hubs.length;
  return [...hubs.slice(start), ...hubs.slice(0, start)];
}

export type CronResult = {
  /** 이번 실행의 거점 순서 (앞 거점의 격자부터 예산을 쓴다) */
  order: string[];
  tiles: { total: number; collected: number; incomplete: number };
  enriched: number;
  failed: number;
  /** 0005 전 행에 채운 list_json 수 (다 채운 뒤에는 0) */
  listJsonFilled?: number;
  /** R38: 오늘 D1 읽기가 소프트 한도를 넘어 수집·보충을 건너뛰었다 */
  skipped?: "read_budget";
  /** R59: 이번 실행이 쓴 외부 호출 수 (카카오 로컬·상세) */
  calls?: number;
  /** R59: 이번 실행이 집계한 날 수 */
  rolled?: number;
};

/**
 * R11: 모든 거점을 PREWARM_RADIUS로 유지한다. 외부 호출 예산 하나를 거점끼리 나눠 쓴다.
 * 거점들의 격자를 합집합(중복 제거)으로 한 번에 처리하고, 상세 후보도 합집합에서 ID 중복 없이
 * 가장 가까운 거점 기준으로 고른다 — 겹치는 거점이 있어도 같은 격자·장소를 두 번 부르지 않는다.
 * D1 읽기를 아끼려고: 만료 후보는 (status, fetched_at) 인덱스로, 미수집 ID는 격자가 바뀐 뒤에만 훑는다.
 * pending은 세지 않는다 (관리용 warm만 센다).
 */
export async function runScheduled(
  env: Env,
  opts: { fetcher: FetchFn; now: number; sleep?: (ms: number) => Promise<void>; hubs?: Hub[] },
): Promise<CronResult> {
  // R38: 이번 실행이 읽고 쓴 행 수를 모아 끝에 한 번 기록한다
  const usage: D1Usage = { read: 0, written: 0 };
  const db = meteredDb(env.DB, usage);
  let result: CronResult | null = null;
  try {
    result = await maintain(env, db, opts);
    // R59: 밀린 일별 집계 (따라잡았으면 meta 한 문장, 4키). 읽기 예산을 넘은 날은 건너뛴다(R59 30% 가드는 runRollups 안). 실패해도 수집 결과는 그대로 둔다
    result.rolled = result.skipped
      ? 0
      : await runRollups(db, opts.now, { readSoftCap: readSoftCap(env) }).catch((e) => {
          console.error("rollup failed", e);
          return 0;
        });
    return result;
  } finally {
    // R38 사용량 + R59 마지막 실행 요약을 한 문장으로 (관리 화면 운영 탭의 "마지막 Cron")
    const r = result;
    const summary = {
      at: opts.now,
      collected: r?.tiles.collected ?? 0,
      incomplete: r?.tiles.incomplete ?? 0,
      enriched: r?.enriched ?? 0,
      failed: r?.failed ?? 0,
      calls: r?.calls ?? 0,
      rolled: r?.rolled ?? 0,
      ...(r === null ? { skipped: "error" } : r.skipped ? { skipped: r.skipped } : {}),
    };
    await recordCronRun(env.DB, usage, opts.now, summary).catch((e) => console.error("d1 usage record failed", e));
  }
}

/** wrangler.jsonc triggers.crons — 본 Cron(수집·보충)과 R56 스냅샷 Cron(2분 어긋나게). 바꾸면 둘 다 바꾼다 */
export const MAIN_CRON = "*/5 * * * *";
export const SNAPSHOT_CRON = "2-59/5 * * * *";

export type SnapshotCronResult = SnapshotRun | { status: "read_budget" };

/**
 * R56: 거점 스냅샷 하나를 만드는 Cron (본 Cron과 다른 실행 — CPU 한도를 따로 쓰고, 만들다 CPU 초과로 죽어도
 * 본 Cron의 사용량 기록은 잃지 않는다). 외부 호출은 없다. 이 실행의 D1 사용량도 따로 기록한다.
 * R38: 오늘 읽기가 소프트 한도를 넘었으면 만들지 않는다 (스냅샷이 없으면 미스는 지금 경로로 답한다).
 */
export async function runSnapshotCron(env: Env, opts: { now: number; hubs?: Hub[] }): Promise<SnapshotCronResult> {
  const usage: D1Usage = { read: 0, written: 0 };
  const db = meteredDb(env.DB, usage);
  try {
    if (await overReadBudget(db, env, opts.now)) return { status: "read_budget" };
    return await maintainSnapshots(db, hubOrder(opts.hubs ?? HUBS, opts.now), opts.now);
  } finally {
    await recordD1Usage(env.DB, usage, opts.now).catch((e) => console.error("d1 usage record failed", e));
  }
}

export type CronRun = { cron: "maintain"; result: CronResult } | { cron: "snapshot"; result: SnapshotCronResult };

/** scheduled 입구: controller.cron으로 나눈다. 모르는 값(로컬 /__scheduled 등)은 본 Cron */
export async function runCron(
  cron: string, env: Env, opts: { fetcher: FetchFn; now: number; sleep?: (ms: number) => Promise<void>; hubs?: Hub[] },
): Promise<CronRun> {
  if (cron === SNAPSHOT_CRON) return { cron: "snapshot", result: await runSnapshotCron(env, opts) };
  return { cron: "maintain", result: await runScheduled(env, opts) };
}

async function maintain(
  env: Env, db: D1Database, opts: { fetcher: FetchFn; now: number; sleep?: (ms: number) => Promise<void>; hubs?: Hub[] },
): Promise<CronResult> {
  const { budgetSize, batchSize, detailCharBudget } = limitsFrom(env);
  const budget = new Budget(budgetSize);
  const hubs = hubOrder(opts.hubs ?? HUBS, opts.now);
  const keys = [...new Set(hubs.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)))];
  // R35: 하루 한 번 90일 지난 이벤트를 지운다 (지울 행만 인덱스로 읽어서 읽기 예산을 넘은 날에도 돈다)
  if (isRetentionWindow(opts.now)) {
    await pruneOldEvents(db, opts.now).catch((e) => console.error("event prune failed", e));
    await pruneRollups(db, opts.now).catch((e) => console.error("rollup prune failed", e));
  }
  if (await overReadBudget(db, env, opts.now)) {
    return {
      order: hubs.map((h) => h.id), tiles: { total: keys.length, collected: 0, incomplete: 0 }, enriched: 0, failed: 0,
      skipped: "read_budget", calls: 0,
    };
  }

  const tiles = await collectTiles({ db, fetcher: opts.fetcher, restKey: env.KAKAO_REST_KEY, budget, now: opts.now }, keys);
  const result: CronResult = {
    order: hubs.map((h) => h.id),
    tiles: { total: keys.length, collected: tiles.collected.length, incomplete: tiles.incomplete.length + tiles.failed.length },
    enriched: 0,
    failed: 0,
  };
  // R12: 목록 원소 조각이 없는 예전 행을 실행마다 최대 200행 채운다 (외부 호출 없음, 다 채우면 meta 1행만 읽는다)
  result.listJsonFilled = await backfillListJson(db).catch((e) => {
    console.error("list_json backfill failed", e);
    return 0;
  });
  // R10 쿨다운·R44 강등 모드면 상세 후보를 읽지도 부르지도 않는다
  const spent = () => {
    result.calls = budgetSize - budget.left;
    return result;
  };
  if (budget.left <= 0 || !detailsAllowed(await detailGate(db), opts.now)) return spent();

  const candidates: TilePlaceState[] = await expiredDetailStates(db, keys, opts.now);
  // 격자가 바뀐 적이 없으면(마지막 확인 이후) 미수집 ID가 생길 수 없으니 훑지 않는다
  const checkUnfetched = (await tilesChangedAt(db)) >= (await unfetchedClearedAt(db));
  let unfetched = 0;
  if (checkUnfetched) {
    // Task 34: 미수집은 거점에 가까운 순 batchSize곳만 받아 온다 (만료 후보와 합쳐 고르는 결과는 전부 받아 온 것과 같다)
    const u = await nearestUnfetchedStates(db, keys, hubs, batchSize);
    unfetched = u.length;
    candidates.push(...u);
  }
  if (candidates.length > 0) {
    const e = await enrichDetails(
      {
        db, fetcher: opts.fetcher, budget, now: opts.now, batchSize, sleep: opts.sleep, candidates, charBudget: detailCharBudget,
      },
      hubs,
      PREWARM_RADIUS,
    );
    result.enriched = e.enriched;
    result.failed = e.failed;
  }
  if (checkUnfetched && unfetched === 0) await markUnfetchedCleared(db, opts.now);
  return spent();
}
