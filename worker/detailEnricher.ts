import { detailFingerprint, fpKind } from "../shared/adaptiveRefresh";
import type { LatLng } from "../shared/types";
import type { Budget } from "./budget";
import { DEFAULT_DETAIL_CHAR_BUDGET } from "./config";
import type { DetailTally } from "./d1Usage";
import type { FetchFn } from "./fetchFn";
import { fetchPlaceDetail } from "./kakaoPlace";
import { mapLimit } from "./pool";
import {
  detailGate, detailsAllowed, nearestDetailStates, pickDetailIds, recordPlaceBlock, saveDetail, saveDetailFailure, saveDetails,
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
  /** R63: 이미 순서대로 고른 ID (Cron — pickCronIds). 있으면 candidates·center로 다시 고르지 않는다 (candidates는 R66 지난 지문으로만 본다) */
  ids?: string[];
  /** R66: 저장한 상세를 지난 지문(후보 상태의 fp — 없으면 처음)과 비교해 같음·바뀜·처음을 센다 (실행 끝의 사용량 기록이 쓴다) */
  tally?: DetailTally;
  /** 한 번에 풀 상세 JSON 글자 수 (없으면 DEFAULT_DETAIL_CHAR_BUDGET) — Task 34 */
  charBudget?: number;
  /** Task 34: 실행의 D1 호출 예산. 새 상세는 저장·차단 기록 몫이 남았을 때만 시작하고, 한 곳씩 다시 저장은 그만큼 남았을 때만 */
  d1?: { has(n: number): boolean };
};

/** 새 상세를 시작하려면 남아 있어야 하는 D1 호출: 마지막 묶음 저장 1 + 차단 기록(최악 3) */
export const ENRICH_START_CALLS = 4;
/** 보충 한 번이 쓰는 D1 호출 최악: 게이트 1 + 묶음 저장(첫 곳 1 + 3곳씩) + 한 곳씩 다시(곳마다 1) + 차단 기록 3 */
export const enrichCallReserve = (batchSize: number) =>
  1 + 1 + Math.ceil(Math.max(0, batchSize - 1) / DETAIL_CONCURRENCY) + Math.max(0, batchSize) + 3;
/**
 * deferred: 글자 예산을 다 써서 이번에 시작하지 않고 남긴 곳 (실패가 아니다 — 다음 실행이 이어 한다).
 * chars: 이번에 읽은 상세 본문 글자 수. truncated: 후보 고르기가 쪽 상한에서 멈췄다 (남은 후보가 있을 수 있다)
 */
export type EnrichResult = {
  enriched: number; failed: number; deferred: number; chars: number; truncated: boolean;
  /** 저장(또는 차단 기록) 중 첫 오류 — 던지지 않고 실어서 센 수를 잃지 않는다 (받은 결과는 묶음마다 이미 저장했다) */
  error?: unknown;
};

/**
 * center: 기준점. candidates를 넘길 때는 여러 거점을 넘겨서 가장 가까운 거점 기준으로 줄 세울 수 있다.
 *
 * Task 34 (무료 플랜 CPU 10ms): 한 번의 보충에서 Worker CPU는 대부분 상세 본문 JSON을 푸는 데 쓰인다.
 * - 읽은 본문 글자 수를 모아 charBudget 이상이면 새 상세를 시작하지 않는다 (이미 시작한 곳은 끝낸다 — 동시 DETAIL_CONCURRENCY곳.
 *   첫 곳들은 언제나 시작한다). 외부 호출 예산(Budget)은 그대로 따로 지킨다.
 * - 결과는 받는 대로 작은 묶음으로 저장한다: 첫 결과는 혼자 바로(실행이 CPU 한도로 죽어도 적어도 한 곳은 나아간다),
 *   그다음은 DETAIL_CONCURRENCY곳씩, 남은 것은 끝에. 묶음마다 D1 batch 하나(saveDetails — 한 곳씩 저장한 것과 같은 행).
 *   묶음의 batch가 실패하면 그 묶음을 한 곳씩 다시 저장해서 문제 있는 한 곳이 다른 곳을 막지 않는다.
 * - 작업자 안의 오류(차단 기록·저장)는 잡아 두고 모든 작업자가 끝나 남은 결과를 저장한 뒤 첫 오류를 결과(error)에 싣는다
 *   (부르는 쪽이 로그·요약에 남긴다 — 던지면 enriched·failed 수를 잃는다).
 */
export async function enrichDetails(
  deps: EnrichDeps, center: LatLng | LatLng[], radiusM: number,
): Promise<EnrichResult> {
  const result: EnrichResult = { enriched: 0, failed: 0, deferred: 0, chars: 0, truncated: false };
  if (deps.budget.left <= 0) return result;
  // R10 쿨다운·R44 강등 모드면 후보도 고르지 않는다
  if (!detailsAllowed(await detailGate(deps.db), deps.now)) return result;
  const scope = deps.scope ?? "due";
  let ids: string[];
  // R66: id → 지난 지문 (후보를 읽은 질의에 있다 — 상세 행이 없거나 지문이 없으면 null = 처음)
  const prevFp = new Map<string, string | null>();
  const notePrev = (states: TilePlaceState[]) => {
    for (const t of states) prevFp.set(t.id, t.meta?.fp ?? null);
  };
  if (deps.candidates) notePrev(deps.candidates);
  if (deps.ids) ids = deps.ids.slice(0, Math.max(0, deps.batchSize));
  else if (deps.candidates) ids = pickDetailIds(deps.candidates, center, deps.now, deps.batchSize, scope);
  else {
    const picked = await nearestDetailStates(
      deps.db, Array.isArray(center) ? center[0] : center, radiusM, deps.now, deps.batchSize, scope,
    );
    notePrev(picked.states);
    ids = picked.states.map((t) => t.id);
    result.truncated = picked.truncated;
  }
  const charBudget = deps.charBudget ?? DEFAULT_DETAIL_CHAR_BUDGET;
  const onBody = (n: number) => {
    result.chars += n;
  };

  let failure: { error: unknown } | null = null;
  const keep = (error: unknown) => {
    failure ??= { error };
  };
  // R66: 저장한 상세만 센다 (실패·저장 오류는 세지 않는다)
  const count = (x: DetailSave) => {
    if (deps.tally && "summary" in x && x.fp !== undefined) deps.tally[fpKind(prevFp.get(x.id), x.fp)] += 1;
  };
  const persist = async (group: DetailSave[]) => {
    try {
      await saveDetails(deps.db, group, deps.now);
      group.forEach(count);
    } catch (e) {
      if (deps.d1 && !deps.d1.has(group.length + 1)) {
        // D1 호출 예산이 모자라면 한 곳씩 다시는 하지 않는다 — 이 묶음은 다음 실행이 다시 가져온다
        console.error("detail batch save failed — one-by-one skipped (D1 call budget)", e);
        keep(e);
        return;
      }
      console.error("detail batch save failed — saving one by one", e);
      for (const x of group) {
        try {
          if ("summary" in x) await saveDetail(deps.db, x.id, x.summary, x.detail, deps.now, { fp: x.fp });
          else await saveDetailFailure(deps.db, x.id, x.reason, deps.now);
          count(x);
        } catch (e2) {
          keep(e2);
        }
      }
    }
  };
  const queue: DetailSave[] = [];
  let flushedOnce = false;
  const flush = async (all: boolean) => {
    if (queue.length === 0 || (!all && queue.length < (flushedOnce ? DETAIL_CONCURRENCY : 1))) return;
    flushedOnce = true;
    await persist(queue.splice(0));
  };

  let blocked = false;
  await mapLimit(ids, DETAIL_CONCURRENCY, async (id) => {
    try {
      if (blocked) return;
      if (result.chars >= charBudget || (deps.d1 && !deps.d1.has(ENRICH_START_CALLS))) {
        result.deferred += 1;
        return;
      }
      const r = await fetchPlaceDetail(deps.fetcher, id, { budget: deps.budget, sleep: deps.sleep, onBody });
      if (r.ok) {
        queue.push({ id, summary: r.summary, detail: r.detail, fp: detailFingerprint(r.summary, r.detail) });
        result.enriched += 1;
      } else if (r.reason !== "budget") {
        queue.push({ id, reason: r.reason });
        result.failed += 1;
        if (BLOCK_SIGNALS.has(r.reason) && !blocked) {
          blocked = true;
          console.warn("place detail blocked", r.reason);
          await recordPlaceBlock(deps.db, deps.now);
        }
      }
      await flush(false);
    } catch (e) {
      keep(e);
    }
  });
  await flush(true);
  if (failure) return { ...result, error: (failure as { error: unknown }).error };
  return result;
}
