import { KAKAO_MAX_RESULTS, KAKAO_PAGE_SIZE, MAX_QUAD_DEPTH } from "../shared/constants";
import { splitRect, tileRect } from "../shared/geo";
import type { Place, Rect } from "../shared/types";
import type { Budget } from "./budget";
import { UpstreamError, type FetchFn } from "./fetchFn";
import { searchRect } from "./kakaoLocal";
import { getTiles, isTileDue, replaceTilePlaces } from "./repo";

export type CollectDeps = { db: D1Database; fetcher: FetchFn; restKey: string; budget: Budget; now: number };
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

export async function collectTiles(deps: CollectDeps, keys: string[]): Promise<CollectResult> {
  const states = await getTiles(deps.db, keys);
  const due = keys.filter((k) => isTileDue(states.get(k), deps.now));
  const result: CollectResult = { collected: [], incomplete: [], failed: [] };
  for (let i = 0; i < due.length; i++) {
    const key = due[i];
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
