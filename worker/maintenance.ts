import { ASEM, PREWARM_RADIUS } from "../shared/constants";
import { tilesCoveringCircle } from "../shared/geo";
import type { LatLng } from "../shared/types";
import { Budget } from "./budget";
import { limitsFrom } from "./config";
import { enrichDetails } from "./detailEnricher";
import type { FetchFn } from "./fetchFn";
import { countNeedingDetail } from "./repo";
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
export type WarmResult = { incompleteTiles: number; pending: number; enriched: number; failed: number };

export async function warmOnce(deps: WarmDeps, center: LatLng, radiusM: number): Promise<WarmResult> {
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
  return {
    incompleteTiles: tiles.incomplete.length + tiles.failed.length,
    pending: await countNeedingDetail(deps.db, center, radiusM, deps.now),
    enriched: e.enriched,
    failed: e.failed,
  };
}

export function runScheduled(
  env: Env, opts: { fetcher: FetchFn; now: number; sleep?: (ms: number) => Promise<void> },
): Promise<WarmResult> {
  return warmOnce(
    { db: env.DB, fetcher: opts.fetcher, restKey: env.KAKAO_REST_KEY, ...limitsFrom(env), now: opts.now, sleep: opts.sleep },
    ASEM,
    PREWARM_RADIUS,
  );
}
