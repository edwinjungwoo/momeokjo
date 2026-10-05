import { boundingBox, haversine, tilesCoveringCircle } from "../shared/geo";
import type { ApiPlace, LatLng, PlacesResponse } from "../shared/types";
import { Budget } from "./budget";
import { BLOCK_SIGNALS, enrichDetails } from "./detailEnricher";
import type { FetchFn } from "./fetchFn";
import { fetchPlaceDetail } from "./kakaoPlace";
import { toApiPlace } from "./present";
import {
  countUnfetchedIn, detailGate, detailsAllowed, frozenSince, getMeta, isInAnyTile, getTiles, isDetailDue, isTileDue,
  placeById, placesInBox, recordPlaceBlock, saveDetail, saveDetailFailure, tilePlaceStates,
} from "./repo";
import { collectTiles } from "./tileCollector";

export type ServiceDeps = {
  db: D1Database;
  fetcher: FetchFn;
  restKey: string;
  budgetSize: number;
  batchSize: number;
  now: number;
  rateLimit: () => Promise<boolean>;
  waitUntil: (p: Promise<unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
};

export async function getPlaces(
  deps: ServiceDeps, center: LatLng, radiusM: number,
): Promise<PlacesResponse | { error: "upstream" }> {
  const keys = tilesCoveringCircle(center, radiusM);
  const states = await getTiles(deps.db, keys);
  const due = keys.filter((k) => isTileDue(states.get(k), deps.now));
  const budget = new Budget(deps.budgetSize);

  let allowed: boolean | null = null;
  const allow = async () => (allowed ??= await deps.rateLimit());

  let incompleteTiles = 0;
  let failedTiles = 0;
  let stale = false;
  if (due.length > 0) {
    if (await allow()) {
      const r = await collectTiles(
        { db: deps.db, fetcher: deps.fetcher, restKey: deps.restKey, budget, now: deps.now }, due, states,
      );
      incompleteTiles = r.incomplete.length;
      failedTiles = r.failed.length;
      stale = failedTiles > 0;
    } else {
      incompleteTiles = due.length;
      stale = true;
    }
  }

  // 격자-장소 상태는 요청마다 한 번만 읽어서 목록 필터, pending, 보충 대상 고르기에 같이 쓴다
  const tileStates = await tilePlaceStates(deps.db, keys);
  const inTiles = new Set(tileStates.map((t) => t.id));
  const rows = (await placesInBox(deps.db, boundingBox(center, radiusM), inTiles))
    .filter((r) => r.place.group !== "dessert")
    .map((row) => ({ row, d: haversine(center, row.place) }))
    .filter((x) => x.d <= radiusM)
    .sort((a, b) => a.d - b.d);

  if (failedTiles > 0 && rows.length === 0) return { error: "upstream" };

  // 보충(waitUntil)이 시작되기 전에 센다 — 응답과 보충이 섞이지 않게.
  // 요청 시점에는 한 번도 가져오지 않은 장소만 보충한다. 만료된 상세 갱신은 Cron(R11) 몫이다.
  const pending = countUnfetchedIn(tileStates);
  // R10 쿨다운·R44 강등 모드 (meta 2행). frozen이면 응답에 시작 시각을 싣는다
  const gate = await detailGate(deps.db);
  const needsDetail = pending > 0 && detailsAllowed(gate, deps.now);
  if (needsDetail && budget.left > 0 && (await allow())) {
    deps.waitUntil(
      enrichDetails(
        {
          db: deps.db, fetcher: deps.fetcher, budget, now: deps.now, batchSize: deps.batchSize, sleep: deps.sleep,
          scope: "unfetched", candidates: tileStates,
        },
        center,
        radiusM,
      ).catch((e) => console.error("enrich failed", e)),
    );
  } else if (needsDetail && allowed === false) {
    stale = true;
  }

  // R44: 실린 가게 중 가장 최근에 상세를 가져온 시각 (실패 기록 시각은 빼고)
  let newest: number | null = null;
  for (const x of rows) if (x.row.meta.status === "ok" && (newest === null || x.row.meta.fetchedAt > newest)) newest = x.row.meta.fetchedAt;

  return {
    center,
    radius: radiusM,
    places: rows.map((x) => toApiPlace(x.row, { distance: x.d })),
    pending,
    incompleteTiles,
    stale,
    detailsFrozenSince: frozenSince(gate, deps.now),
    detailsNewestAt: newest,
  };
}

export async function getPlace(deps: ServiceDeps, id: string): Promise<ApiPlace | null> {
  const row = await placeById(deps.db, id);
  if (row) return toApiPlace(row, { full: true });
  if (!isDetailDue(await getMeta(deps.db, id), deps.now, id)) return null;
  if (!detailsAllowed(await detailGate(deps.db), deps.now)) return null;
  if (!(await deps.rateLimit())) return null;
  const r = await fetchPlaceDetail(deps.fetcher, id, { budget: new Budget(3), sleep: deps.sleep });
  if (!r.ok) {
    // 격자에 없는 ID의 실패는 기록하지 않는다 — 아무 숫자로 D1을 키울 수 없게
    if (r.reason !== "budget" && (await isInAnyTile(deps.db, id))) await saveDetailFailure(deps.db, id, r.reason, deps.now);
    if (BLOCK_SIGNALS.has(r.reason)) await recordPlaceBlock(deps.db, deps.now);
    return null;
  }
  await saveDetail(deps.db, id, r.summary, r.detail, deps.now);
  const fresh = await placeById(deps.db, id);
  return fresh ? toApiPlace(fresh, { full: true }) : null;
}
