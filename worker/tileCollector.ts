import { KAKAO_MAX_RESULTS, KAKAO_PAGE_SIZE, MAX_QUAD_DEPTH } from "../shared/constants";
import { splitRect, tileRect } from "../shared/geo";
import type { Place, Rect } from "../shared/types";
import type { Budget } from "./budget";
import { UpstreamError, type FetchFn } from "./fetchFn";
import { searchRect } from "./kakaoLocal";
import { dueTileKeys, isTileDue, replaceTilePlaces, type TileState } from "./repo";

export type CollectDeps = {
  db: D1Database; fetcher: FetchFn; restKey: string; budget: Budget; now: number;
  /** Task 34: 다음 격자를 시작해도 되는가 (D1 호출 예산 — 격자마다 2번). 아니면 남은 격자는 incomplete */
  canStartTile?: () => boolean;
};
export type CollectResult = { collected: string[]; incomplete: string[]; failed: string[] };

type RectResult = { ids: string[]; saturated: boolean } | "budget";

/** 로컬 API 응답은 이 함수 안에서만 쓰고, 밖으로는 기록할 ID만 내보낸다 */
const idsToRecord = (places: Place[]) => places.filter((p) => p.group !== "dessert").map((p) => p.id);

async function collectRect(deps: CollectDeps, rect: Rect, depth: number): Promise<RectResult> {
  if (!deps.budget.take()) return "budget";
  const first = await searchRect(deps.fetcher, deps.restKey, rect, 1);
  if (first.totalCount > KAKAO_MAX_RESULTS && depth < MAX_QUAD_DEPTH) {
    const ids: string[] = [];
    let saturated = false;
    for (const sub of splitRect(rect)) {
      const r = await collectRect(deps, sub, depth + 1);
      if (r === "budget") return "budget";
      ids.push(...r.ids);
      saturated ||= r.saturated;
    }
    return { ids, saturated };
  }
  const ids = idsToRecord(first.places);
  const pages = Math.ceil(Math.min(first.totalCount, KAKAO_MAX_RESULTS) / KAKAO_PAGE_SIZE);
  for (let page = 2; page <= pages && !first.isEnd; page++) {
    if (!deps.budget.take()) return "budget";
    const next = await searchRect(deps.fetcher, deps.restKey, rect, page);
    ids.push(...idsToRecord(next.places));
    if (next.isEnd) break;
  }
  return { ids, saturated: first.totalCount > KAKAO_MAX_RESULTS };
}

/**
 * known: 이미 읽어 둔 격자 상태가 있으면 넘겨서 다시 읽지 않는다.
 * 없으면 수집할 격자(없음·만료)만 D1에서 고른다 (Task 34: Cron·warm이 격자 상태 수백 행을 매번 받아 오지 않게)
 */
export async function collectTiles(
  deps: CollectDeps, keys: string[], known?: Map<string, TileState>,
): Promise<CollectResult> {
  const due = known ? keys.filter((k) => isTileDue(k, known.get(k), deps.now)) : await dueTileKeys(deps.db, keys, deps.now);
  const result: CollectResult = { collected: [], incomplete: [], failed: [] };
  for (let i = 0; i < due.length; i++) {
    const key = due[i];
    if (deps.canStartTile && !deps.canStartTile()) {
      result.incomplete.push(...due.slice(i));
      break;
    }
    try {
      const r = await collectRect(deps, tileRect(key), 0);
      if (r === "budget") {
        result.incomplete.push(...due.slice(i));
        break;
      }
      await replaceTilePlaces(deps.db, key, r.ids, deps.now, r.saturated);
      result.collected.push(key);
    } catch (e) {
      if (e instanceof UpstreamError) result.failed.push(key);
      else throw e;
    }
  }
  return result;
}
