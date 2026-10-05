import { PREWARM_RADIUS } from "../shared/constants";
import { tilesCoveringCircle } from "../shared/geo";
import { HUBS, type Hub } from "../shared/hubs";
import type { LatLng } from "../shared/types";
import { Budget } from "./budget";
import { limitsFrom } from "./config";
import { meteredDb, overReadBudget, recordD1Usage, type D1Usage } from "./d1Usage";
import { enrichDetails } from "./detailEnricher";
import type { FetchFn } from "./fetchFn";
import {
  countNeedingDetail, expiredDetailStates, markUnfetchedCleared, placeBlockedUntil, tilesChangedAt, unfetchedClearedAt,
  unfetchedStates, type TilePlaceState,
} from "./repo";
import { collectTiles } from "./tileCollector";

export type WarmDeps = {
  db: D1Database;
  fetcher: FetchFn;
  restKey: string;
  budgetSize: number;
  batchSize: number;
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
    { db: deps.db, fetcher: deps.fetcher, budget, now: deps.now, batchSize: deps.batchSize, sleep: deps.sleep },
    center,
    radiusM,
  );
  let pending: WarmResult["pending"];
  if (opts.count) pending = await countNeedingDetail(deps.db, center, radiusM, deps.now);
  else {
    const done = e.enriched + e.failed < deps.batchSize && budget.left > 0 && deps.now >= (await placeBlockedUntil(deps.db));
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
  /** R38: 오늘 D1 읽기가 소프트 한도를 넘어 수집·보충을 건너뛰었다 */
  skipped?: "read_budget";
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
  try {
    return await maintain(env, db, opts);
  } finally {
    await recordD1Usage(env.DB, usage, opts.now).catch((e) => console.error("d1 usage record failed", e));
  }
}

async function maintain(
  env: Env, db: D1Database, opts: { fetcher: FetchFn; now: number; sleep?: (ms: number) => Promise<void>; hubs?: Hub[] },
): Promise<CronResult> {
  const { budgetSize, batchSize } = limitsFrom(env);
  const budget = new Budget(budgetSize);
  const hubs = hubOrder(opts.hubs ?? HUBS, opts.now);
  const keys = [...new Set(hubs.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)))];
  if (await overReadBudget(db, env, opts.now)) {
    return {
      order: hubs.map((h) => h.id), tiles: { total: keys.length, collected: 0, incomplete: 0 }, enriched: 0, failed: 0,
      skipped: "read_budget",
    };
  }

  const tiles = await collectTiles({ db, fetcher: opts.fetcher, restKey: env.KAKAO_REST_KEY, budget, now: opts.now }, keys);
  const result: CronResult = {
    order: hubs.map((h) => h.id),
    tiles: { total: keys.length, collected: tiles.collected.length, incomplete: tiles.incomplete.length + tiles.failed.length },
    enriched: 0,
    failed: 0,
  };
  if (budget.left <= 0 || opts.now < (await placeBlockedUntil(db))) return result;

  const candidates: TilePlaceState[] = await expiredDetailStates(db, keys, opts.now);
  // 격자가 바뀐 적이 없으면(마지막 확인 이후) 미수집 ID가 생길 수 없으니 훑지 않는다
  const checkUnfetched = (await tilesChangedAt(db)) >= (await unfetchedClearedAt(db));
  let unfetched = 0;
  if (checkUnfetched) {
    const u = await unfetchedStates(db, keys);
    unfetched = u.length;
    candidates.push(...u);
  }
  if (candidates.length > 0) {
    const e = await enrichDetails(
      { db, fetcher: opts.fetcher, budget, now: opts.now, batchSize, sleep: opts.sleep, candidates },
      hubs,
      PREWARM_RADIUS,
    );
    result.enriched = e.enriched;
    result.failed = e.failed;
  }
  if (checkUnfetched && unfetched === 0) await markUnfetchedCleared(db, opts.now);
  return result;
}
