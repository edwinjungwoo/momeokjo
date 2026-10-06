import { PREWARM_RADIUS } from "../shared/constants";
import { tilesCoveringCircle } from "../shared/geo";
import { HUBS, PUBLIC_HUBS, type Hub } from "../shared/hubs";
import type { LatLng } from "../shared/types";
import { Budget } from "./budget";
import { limitsFrom } from "./config";
import { D1CallBudget, meteredDb, overReadBudget, readSoftCap, recordCronRun, recordD1Usage, type D1Usage } from "./d1Usage";
import { enrichCallReserve, enrichDetails } from "./detailEnricher";
import { isRetentionWindow, pruneOldEvents } from "./events";
import { pruneRollups, runRollups } from "./rollup";
import type { FetchFn } from "./fetchFn";
import { maintainSnapshots, type SnapshotRun } from "./hubSnapshot";
import {
  backfillListJson, countNeedingDetail, detailGate, detailsAllowed, EXPIRED_RESET_PAGES, expiredDetailStates,
  nearestUnfetchedStates, tilesChangedAt, UNFETCHED_MAX_CHUNKS, type TilePlaceState,
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
  /** Task 34: 이 요청의 D1 호출 예산 (없으면 보지 않는다) */
  d1?: D1CallBudget;
  now: number;
  sleep?: (ms: number) => Promise<void>;
};
/**
 * pending: 남은 상세 수. 세지 않을 때는 0(끝) 또는 "more"(더 있을 수 있음).
 * deferred: 글자 예산으로 남긴 곳, chars: 읽은 상세 본문 글자 수 (Task 34 — 운영 CPU를 맞춰 보는 값)
 */
export type WarmResult = {
  incompleteTiles: number; pending: number | "more"; enriched: number; failed: number; deferred: number; chars: number;
  /** 후보 고르기가 쪽 상한에서 멈췄다 (warm.mjs는 격자를 다 모은 뒤 아무것도 못 한 채 3번 이어지면 멈춘다) */
  truncated: boolean;
  /** 보충 저장 오류가 있었다 (센 수는 그대로, 원인은 Workers 로그) */
  enrichError?: true;
};

/**
 * R31: 한 번 수집·보충한다. 남은 수(pending)를 세려고 격자 전체를 다시 훑지 않는다(R38) —
 * 이번에 고른 상세가 배치를 다 채우지 못했고 예산·쿨다운으로 멈추지 않았으면 남은 것이 없다.
 * opts.count면 예전처럼 정확히 센다(전체 스캔, 명시적으로 요청할 때만).
 */
export async function warmOnce(
  deps: WarmDeps, center: LatLng, radiusM: number, opts: { count?: boolean } = {},
): Promise<WarmResult> {
  const budget = new Budget(deps.budgetSize);
  // 격자 하나 = D1 2번. 보충(후보 고르기 ≤ 3쪽 + 보충 최악)과 pending 게이트 몫을 남긴다
  const d1 = deps.d1;
  const afterCollect = 3 + enrichCallReserve(deps.batchSize) + 1;
  const tiles = await collectTiles(
    {
      db: deps.db, fetcher: deps.fetcher, restKey: deps.restKey, budget, now: deps.now,
      canStartTile: d1 ? () => d1.has(2 + afterCollect) : undefined,
    },
    tilesCoveringCircle(center, radiusM),
  );
  const e = await enrichDetails(
    {
      db: deps.db, fetcher: deps.fetcher, budget, now: deps.now, batchSize: deps.batchSize, sleep: deps.sleep,
      charBudget: deps.detailCharBudget, d1,
    },
    center,
    radiusM,
  );
  if (e.error !== undefined) console.error("warm enrich failed", e.error);
  let pending: WarmResult["pending"];
  if (opts.count) {
    // 정확히 세기(?count=1)는 격자-장소 상태를 다 읽는다 (90칸마다 D1 1번). 예산이 모자라면 세지 않고 more
    const countCalls = Math.ceil(tilesCoveringCircle(center, radiusM).length / 90);
    pending = d1 && !d1.has(countCalls) ? "more" : await countNeedingDetail(deps.db, center, radiusM, deps.now);
  } else {
    // 글자·D1 호출 예산으로 남긴 곳(deferred)이 있거나 후보 고르기가 쪽 상한에서 멈췄거나(truncated)
    // D1 호출 예산으로 격자를 다 모으지 못했으면(새 ID가 더 있을 수 있다) 끝나지 않았다
    const done =
      e.enriched + e.failed < deps.batchSize && e.deferred === 0 && !e.truncated && tiles.incomplete.length === 0 &&
      budget.left > 0 &&
      detailsAllowed(await detailGate(deps.db), deps.now);
    pending = done ? 0 : "more";
  }
  return {
    incompleteTiles: tiles.incomplete.length + tiles.failed.length, pending, enriched: e.enriched, failed: e.failed,
    deferred: e.deferred, chars: e.chars, truncated: e.truncated, ...(e.error !== undefined ? { enrichError: true as const } : {}),
  };
}

/**
 * 무료 플랜: Worker 실행 하나의 D1 질의 50개 (batch()는 왕복 하나로 센다) — 본 Cron·warm이 이 안에서 끝나게 단계마다 남은 수를 본다.
 * CRON_D1_RESERVE: 끝의 사용량·요약 기록(recordCronRun / 요청 미들웨어의 recordD1Usage) 1번과 여유
 */
export const CRON_D1_CALL_LIMIT = 50;
/**
 * 끝의 기록 1번 + 여유 4번. 여유는 보충의 동시 시작 넘침도 받는다: 동시 DETAIL_CONCURRENCY곳이 같은 때 "4번 남았나"를
 * 확인하고 시작하면 마지막 묶음 저장·차단 기록이 그보다 1~2번 더 쓸 수 있다
 */
export const CRON_D1_RESERVE = 5;
/** 집계(R59) 한 번의 최악 D1 호출: meta 1 + 첫 날 찾기 1 + 하루 batch × 3 + 실패 기록 2 */
export const ROLLUP_D1_CALLS = 7;
/** 만료 후보 한 번의 최악: meta 1 + 상태마다 재설정 쪽 수 + 커서 쓰기 1 */
const EXPIRED_D1_CALLS = 1 + 2 * EXPIRED_RESET_PAGES + 1;
/** 미수집 후보를 찾는 최소: 커서 읽기 1 + 묶음 1 + 커서 쓰기 1 */
const FRONTIER_MIN_CALLS = 3;
/** list_json 백필 최악: 커서 읽기 1 + 행 읽기 1 + 쓰기 batch 1 */
const BACKFILL_D1_CALLS = 3;
/**
 * 격자 수집 뒤에 남겨 둘 D1 호출 (격자 하나 = 2번): 백필 + 게이트 1 + tiles_changed_at 1 + 미수집 최소 + 보충 최악 + 집계.
 * 격자 수집이 많은 실행에서도 미수집 보충은 언제나 한다. 만료 후보(최악 8번)는 남은 것이 넉넉할 때만 한다 (다음 실행)
 */
export const afterCollectCalls = (batchSize: number) =>
  BACKFILL_D1_CALLS + 1 + 1 + FRONTIER_MIN_CALLS + enrichCallReserve(batchSize) + ROLLUP_D1_CALLS;

/** 보충 말고 한 실행이 늘 할 수 있게 남겨 둘 D1 호출: 격자 확인 1 + 격자 2칸 + 백필 + 게이트 + tiles_changed_at + 만료 최악 + 미수집 최소 + 집계 */
const NON_ENRICH_CALLS = 1 + 2 * 2 + BACKFILL_D1_CALLS + 1 + 1 + EXPIRED_D1_CALLS + FRONTIER_MIN_CALLS + ROLLUP_D1_CALLS;

/**
 * Task 34: 이번 실행의 유효 배치 = min(설정, 남은 D1 호출 left로 보충 최악(enrichCallReserve)이 들어가는 가장 큰 값).
 * 만료 후보·격자·미수집·집계 몫을 먼저 남긴다 — DETAIL_BATCH_SIZE를 올려도 다른 단계를 밀어내지 않는다 (천장 MAX_DETAIL_BATCH_SIZE)
 */
export function cronBatchFor(left: number, batchSize: number): number {
  let b = Math.max(0, Math.floor(batchSize));
  while (b > 0 && enrichCallReserve(b) > left - NON_ENRICH_CALLS) b--;
  return b;
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
  /** Task 34: 글자 예산·D1 호출 예산으로 남긴 곳과 읽은 상세 본문 글자 수 (보충을 했을 때만) */
  deferred?: number;
  chars?: number;
  /** Task 34: 이번 실행의 D1 호출 수 (끝의 사용량 기록 1번은 빼고) */
  d1Calls?: number;
  /** Task 34: D1 호출 예산 때문에 건너뛴 단계 */
  d1Skipped?: string[];
  /** Task 34: 보충 중 저장 오류가 있었다 (로그에 원인, 센 수는 그대로) */
  enrichError?: true;
  /** Task 34: 이번 실행의 유효 배치 (cronBatchFor) */
  batch?: number;
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
 * R11: 모든 거점을 PREWARM_RADIUS로 유지한다 (R62 준비 중 거점 포함 — 공개 전에 채운다). 외부 호출 예산 하나를 거점끼리 나눠 쓴다.
 * 거점들의 격자를 합집합(중복 제거)으로 한 번에 처리하고, 상세 후보도 합집합에서 ID 중복 없이
 * 가장 가까운 거점 기준으로 고른다 — 겹치는 거점이 있어도 같은 격자·장소를 두 번 부르지 않는다.
 * D1 읽기를 아끼려고: 만료 후보는 (status, fetched_at) 인덱스와 커서로, 미수집은 앞선 커서(unfetched_from)부터 묶음씩 읽는다
 * (커서가 끝이고 격자가 그대로면 meta 1행만). 실행당 D1 호출은 CRON_D1_CALL_LIMIT 안에서 단계마다 남은 수를 본다 (Task 34).
 * pending은 세지 않는다 (관리용 warm만 센다).
 */
export async function runScheduled(
  env: Env,
  opts: { fetcher: FetchFn; now: number; sleep?: (ms: number) => Promise<void>; hubs?: Hub[] },
): Promise<CronResult> {
  // R38: 이번 실행이 읽고 쓴 행 수를 모아 끝에 한 번 기록한다
  const usage: D1Usage = { read: 0, written: 0 };
  const db = meteredDb(env.DB, usage);
  // Task 34: 실행 하나의 D1 호출 예산 (끝의 recordCronRun 몫은 남긴다)
  const calls = new D1CallBudget(usage, CRON_D1_CALL_LIMIT - CRON_D1_RESERVE);
  let result: CronResult | null = null;
  try {
    result = await maintain(env, db, { ...opts, calls });
    // R59: 밀린 일별 집계 (따라잡았으면 meta 한 문장, 4키). 읽기 예산을 넘은 날은 건너뛴다(R59 30% 가드는 runRollups 안). 실패해도 수집 결과는 그대로 둔다
    // Task 34: D1 호출이 모자라면 다음 실행으로 미룬다
    if (!result.skipped && !calls.has(ROLLUP_D1_CALLS)) (result.d1Skipped ??= []).push("rollup");
    result.rolled = result.skipped || !calls.has(ROLLUP_D1_CALLS)
      ? 0
      : await runRollups(db, opts.now, { readSoftCap: readSoftCap(env) }).catch((e) => {
          console.error("rollup failed", e);
          return 0;
        });
    result.d1Calls = calls.used;
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
      // Task 34: 관리 화면 "마지막 Cron"에 경고로 보인다
      ...(r?.enrichError ? { enrichError: true as const } : {}),
      ...(r?.d1Skipped ? { d1Skipped: r.d1Skipped } : {}),
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
 * R62: 공개 거점만 만든다 (준비 중 거점은 목록 API가 400이라 읽을 일이 없고, 남은 행은 maintainSnapshots가 지운다).
 */
export async function runSnapshotCron(env: Env, opts: { now: number; hubs?: Hub[] }): Promise<SnapshotCronResult> {
  const usage: D1Usage = { read: 0, written: 0 };
  const db = meteredDb(env.DB, usage);
  try {
    if (await overReadBudget(db, env, opts.now)) return { status: "read_budget" };
    return await maintainSnapshots(db, hubOrder(opts.hubs ?? PUBLIC_HUBS, opts.now), opts.now);
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
  env: Env, db: D1Database,
  opts: { fetcher: FetchFn; now: number; sleep?: (ms: number) => Promise<void>; hubs?: Hub[]; calls: D1CallBudget },
): Promise<CronResult> {
  const { budgetSize, batchSize: configured, detailCharBudget } = limitsFrom(env);
  const calls = opts.calls;
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

  // Task 34: 이번 실행의 유효 배치 — 만료·격자·미수집·집계 몫을 남기고 보충 최악이 들어가는 만큼
  const batchSize = cronBatchFor(calls.left, configured);
  // 격자 하나 = D1 2번 (지금 ID 읽기 + 바꾸기). 뒤 단계 몫(afterCollectCalls)이 남을 때만 다음 격자를 시작한다
  const reserve = afterCollectCalls(batchSize);
  const tiles = await collectTiles(
    {
      db, fetcher: opts.fetcher, restKey: env.KAKAO_REST_KEY, budget, now: opts.now,
      canStartTile: () => calls.has(2 + reserve),
    },
    keys,
  );
  const result: CronResult = {
    order: hubs.map((h) => h.id),
    tiles: { total: keys.length, collected: tiles.collected.length, incomplete: tiles.incomplete.length + tiles.failed.length },
    enriched: 0,
    failed: 0,
    batch: batchSize,
  };
  const skip = (stage: string) => (result.d1Skipped ??= []).push(stage);
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

  // tiles_changed_at은 한 번만 읽어 두 커서(만료·미수집)에 넘긴다 — 이 값을 본 뒤의 격자 변화는 다음 실행이 알아본다
  const changedAt = await tilesChangedAt(db);
  const tail = enrichCallReserve(batchSize) + ROLLUP_D1_CALLS;
  const candidates: TilePlaceState[] = [];
  if (calls.has(EXPIRED_D1_CALLS + FRONTIER_MIN_CALLS + tail)) {
    candidates.push(...(await expiredDetailStates(db, keys, opts.now, changedAt)));
  } else skip("expired");
  if (batchSize > 0) {
    // Task 34: 미수집은 앞선 커서부터 거점에 가까운 순 batchSize곳만 (만료 후보와 합쳐 고르는 결과는 전부 읽은 것과 같다).
    // 커서가 끝이고 tiles_changed_at·지문이 같으면 묶음 질의 없이 끝난다 (따로 "다 채움" 표시를 두지 않는다)
    const maxQueries = Math.min(2 + UNFETCHED_MAX_CHUNKS, calls.left - tail);
    if (maxQueries >= FRONTIER_MIN_CALLS) {
      const u = await nearestUnfetchedStates(db, keys, hubs, batchSize, { changedAt, maxQueries });
      candidates.push(...u.states);
    } else skip("unfetched");
  }
  if (candidates.length > 0 && batchSize > 0) {
    const e = await enrichDetails(
      {
        db, fetcher: opts.fetcher, budget, now: opts.now, batchSize, sleep: opts.sleep, candidates, charBudget: detailCharBudget,
        d1: calls,
      },
      hubs,
      PREWARM_RADIUS,
    );
    result.enriched = e.enriched;
    result.failed = e.failed;
    result.deferred = e.deferred;
    result.chars = e.chars;
    if (e.error !== undefined) {
      // 저장 오류가 있어도 센 수·집계·기록은 지킨다 (받은 결과는 enrichDetails가 묶음마다 이미 저장했다)
      console.error("enrich failed", e.error);
      result.enrichError = true;
    }
  }
  return spent();
}
