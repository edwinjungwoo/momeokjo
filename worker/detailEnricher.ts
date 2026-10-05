import { PLACE_BLOCK_COOLDOWN_MS } from "../shared/constants";
import type { LatLng } from "../shared/types";
import type { Budget } from "./budget";
import type { FetchFn } from "./fetchFn";
import { fetchPlaceDetail } from "./kakaoPlace";
import { mapLimit } from "./pool";
import {
  blockPlaceApi, idsNeedingDetail, placeBlockedUntil, saveDetail, saveDetailFailure, type DetailScope,
} from "./repo";

const CONCURRENCY = 3;
/** 비공식 API가 우리를 막기 시작했다는 신호 — 더 두드리지 않는다 */
export const BLOCK_SIGNALS = new Set(["http_403", "http_429"]);

export type EnrichDeps = {
  db: D1Database;
  fetcher: FetchFn;
  budget: Budget;
  now: number;
  batchSize: number;
  sleep?: (ms: number) => Promise<void>;
  /** 기본 due. 요청 시점 보충은 unfetched */
  scope?: DetailScope;
};
export type EnrichResult = { enriched: number; failed: number };

export async function enrichDetails(deps: EnrichDeps, center: LatLng, radiusM: number): Promise<EnrichResult> {
  const result: EnrichResult = { enriched: 0, failed: 0 };
  if (deps.budget.left <= 0) return result;
  if (deps.now < (await placeBlockedUntil(deps.db))) return result;
  const ids = await idsNeedingDetail(deps.db, center, radiusM, deps.now, deps.batchSize, deps.scope ?? "due");
  let blocked = false;
  await mapLimit(ids, CONCURRENCY, async (id) => {
    if (blocked) return;
    const r = await fetchPlaceDetail(deps.fetcher, id, { budget: deps.budget, sleep: deps.sleep });
    if (r.ok) {
      await saveDetail(deps.db, id, r.summary, r.detail, deps.now);
      result.enriched += 1;
    } else if (r.reason !== "budget") {
      await saveDetailFailure(deps.db, id, r.reason, deps.now);
      result.failed += 1;
      if (BLOCK_SIGNALS.has(r.reason) && !blocked) {
        blocked = true;
        console.warn("place detail blocked", r.reason);
        await blockPlaceApi(deps.db, deps.now + PLACE_BLOCK_COOLDOWN_MS);
      }
    }
  });
  return result;
}
