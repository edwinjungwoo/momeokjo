import type { LatLng } from "../shared/types";
import type { Budget } from "./budget";
import type { FetchFn } from "./fetchFn";
import { fetchPlaceDetail } from "./kakaoPlace";
import { mapLimit } from "./pool";
import {
  detailGate, detailsAllowed, idsNeedingDetail, pickDetailIds, recordPlaceBlock, saveDetail, saveDetailFailure,
  type DetailScope, type TilePlaceState,
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
  /** 이미 읽어 둔 격자-장소 상태가 있으면 D1을 다시 훑지 않고 여기서 고른다 */
  candidates?: TilePlaceState[];
};
export type EnrichResult = { enriched: number; failed: number };

/** center: 기준점. candidates를 넘길 때는 여러 거점을 넘겨서 가장 가까운 거점 기준으로 줄 세울 수 있다 */
export async function enrichDetails(
  deps: EnrichDeps, center: LatLng | LatLng[], radiusM: number,
): Promise<EnrichResult> {
  const result: EnrichResult = { enriched: 0, failed: 0 };
  if (deps.budget.left <= 0) return result;
  // R10 쿨다운·R44 강등 모드면 후보도 고르지 않는다
  if (!detailsAllowed(await detailGate(deps.db), deps.now)) return result;
  const scope = deps.scope ?? "due";
  const ids = deps.candidates
    ? pickDetailIds(deps.candidates, center, deps.now, deps.batchSize, scope)
    : await idsNeedingDetail(deps.db, Array.isArray(center) ? center[0] : center, radiusM, deps.now, deps.batchSize, scope);
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
        await recordPlaceBlock(deps.db, deps.now);
      }
    }
  });
  return result;
}
