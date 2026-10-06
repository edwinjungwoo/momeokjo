import type { LatLng } from "../shared/types";
import type { Budget } from "./budget";
import { DEFAULT_DETAIL_CHAR_BUDGET } from "./config";
import type { FetchFn } from "./fetchFn";
import { fetchPlaceDetail } from "./kakaoPlace";
import { mapLimit } from "./pool";
import {
  detailGate, detailsAllowed, idsNeedingDetail, pickDetailIds, recordPlaceBlock, saveDetails,
  type DetailSave, type DetailScope, type TilePlaceState,
} from "./repo";

/** 동시에 부르는 상세 수 */
export const DETAIL_CONCURRENCY = 3;
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
  /** 한 번에 풀 상세 JSON 글자 수 (없으면 DEFAULT_DETAIL_CHAR_BUDGET) — Task 34 */
  charBudget?: number;
};
/** deferred: 글자 예산을 다 써서 이번에 시작하지 않고 남긴 곳 (실패가 아니다 — 다음 실행이 이어 한다) */
export type EnrichResult = { enriched: number; failed: number; deferred: number };

/**
 * center: 기준점. candidates를 넘길 때는 여러 거점을 넘겨서 가장 가까운 거점 기준으로 줄 세울 수 있다.
 *
 * Task 34 (무료 플랜 CPU 10ms): 한 번의 보충에서 Worker CPU는 대부분 상세 본문 JSON을 푸는 데 쓰인다.
 * - 읽은 본문 글자 수를 모아 charBudget 이상이면 새 상세를 시작하지 않는다 (이미 시작한 곳은 끝낸다 — 동시 DETAIL_CONCURRENCY곳.
 *   첫 곳들은 언제나 하므로 매 실행 적어도 한 곳은 나아간다). 외부 호출 예산(Budget)은 그대로 따로 지킨다.
 * - 결과(상세·실패)는 끝에 D1 batch 하나로 저장한다 (saveDetails — 한 곳씩 저장한 것과 같은 행).
 */
export async function enrichDetails(
  deps: EnrichDeps, center: LatLng | LatLng[], radiusM: number,
): Promise<EnrichResult> {
  const result: EnrichResult = { enriched: 0, failed: 0, deferred: 0 };
  if (deps.budget.left <= 0) return result;
  // R10 쿨다운·R44 강등 모드면 후보도 고르지 않는다
  if (!detailsAllowed(await detailGate(deps.db), deps.now)) return result;
  const scope = deps.scope ?? "due";
  const ids = deps.candidates
    ? pickDetailIds(deps.candidates, center, deps.now, deps.batchSize, scope)
    : await idsNeedingDetail(deps.db, Array.isArray(center) ? center[0] : center, radiusM, deps.now, deps.batchSize, scope);
  const charBudget = deps.charBudget ?? DEFAULT_DETAIL_CHAR_BUDGET;
  let chars = 0;
  const onBody = (n: number) => {
    chars += n;
  };
  const saves: DetailSave[] = [];
  let blocked = false;
  let error: unknown = null;
  try {
    await mapLimit(ids, DETAIL_CONCURRENCY, async (id) => {
      if (blocked) return;
      if (chars >= charBudget) {
        result.deferred += 1;
        return;
      }
      const r = await fetchPlaceDetail(deps.fetcher, id, { budget: deps.budget, sleep: deps.sleep, onBody });
      if (r.ok) {
        saves.push({ id, summary: r.summary, detail: r.detail });
        result.enriched += 1;
      } else if (r.reason !== "budget") {
        saves.push({ id, reason: r.reason });
        result.failed += 1;
        if (BLOCK_SIGNALS.has(r.reason) && !blocked) {
          blocked = true;
          console.warn("place detail blocked", r.reason);
          await recordPlaceBlock(deps.db, deps.now);
        }
      }
    });
  } catch (e) {
    // 차단 기록이 실패해도 이미 받은 상세는 저장한다
    error = e;
  }
  await saveDetails(deps.db, saves, deps.now);
  if (error !== null) throw error;
  return result;
}
