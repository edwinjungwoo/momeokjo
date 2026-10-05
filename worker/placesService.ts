import { boundingBox, haversine, tilesCoveringCircle } from "../shared/geo";
import type { ApiPlace, LatLng } from "../shared/types";
import { Budget } from "./budget";
import { BLOCK_SIGNALS, enrichDetails } from "./detailEnricher";
import type { FetchFn } from "./fetchFn";
import { hubTileKeys } from "./hubTiles";
import { fetchPlaceDetail } from "./kakaoPlace";
import { toApiPlace, withDistance, type PlacesMeta } from "./present";
import {
  countUnfetchedIn, detailGate, detailRow, detailsAllowed, frozenSince, getMeta, isInTiles, getTiles, isDetailDue, isTileDue,
  listRowsInBox, placeById, recordPlaceBlock, saveDetail, saveDetailFailure, tilePlaceStates,
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

/** R12 응답: 메타 필드 + 거리순 목록 원소 JSON 조각 (본문은 present.ts placesBody로 이어 붙인다) */
export type PlacesPayload = PlacesMeta & { items: string[] };

export async function getPlaces(
  deps: ServiceDeps, center: LatLng, radiusM: number,
): Promise<PlacesPayload | { error: "upstream" }> {
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
      // R15: 요청 제한이면 수집을 건너뛸 뿐이다 (stale은 공식 API 실패만 — 이 응답은 10초 캐시된다)
      incompleteTiles = due.length;
    }
  }

  // 격자-장소 상태는 요청마다 한 번만 읽어서 목록 필터, pending, 보충 대상 고르기에 같이 쓴다
  const tileStates = await tilePlaceStates(deps.db, keys);
  const inTiles = new Set(tileStates.map((t) => t.id));
  // 미리 만든 목록 원소 조각(list_json)을 쓴다 — 행마다 JSON 열 4개를 parse·stringify하지 않는다 (0005)
  const rows = (await listRowsInBox(deps.db, boundingBox(center, radiusM), inTiles))
    .filter((r) => r.group !== "dessert")
    .map((row) => ({ row, d: haversine(center, row) }))
    .filter((x) => x.d <= radiusM)
    .sort((a, b) => a.d - b.d);

  if (failedTiles > 0 && rows.length === 0) return { error: "upstream" };

  // 보충(waitUntil)이 시작되기 전에 센다 — 응답과 보충이 섞이지 않게.
  // 요청 시점에는 한 번도 가져오지 않은 장소만 보충한다. 만료된 상세 갱신은 Cron(R11) 몫이다.
  const pending = countUnfetchedIn(tileStates);
  // R10 쿨다운·R44 강등 모드 (meta 2행). frozen이면 응답에 시작 시각을 싣는다
  const gate = await detailGate(deps.db);
  const detailsPaused = !detailsAllowed(gate, deps.now);
  // 요청 제한에 걸리면 보충만 건너뛴다 (pending은 그대로, stale 아님)
  if (pending > 0 && !detailsPaused && budget.left > 0 && (await allow())) {
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
  }

  // R44: 실린 가게 중 가장 최근에 상세를 가져온 시각 (실패 기록 시각은 빼고)
  let newest: number | null = null;
  for (const x of rows) if (x.row.status === "ok" && (newest === null || x.row.fetchedAt > newest)) newest = x.row.fetchedAt;

  return {
    center,
    radius: radiusM,
    items: rows.map((x) => withDistance(x.row.json, x.d)),
    pending,
    incompleteTiles,
    stale,
    detailsPaused,
    detailsFrozenSince: frozenSince(gate, deps.now),
    detailsNewestAt: newest,
  };
}

/** R13 단건: stored=false면 거점 격자 밖 id라 D1에 저장하지 않고 보여주기만 한 응답 (app.ts가 엣지에 잠깐 둔다) */
export type PlaceResult = { place: ApiPlace; stored: boolean };

export async function getPlace(deps: ServiceDeps, id: string): Promise<PlaceResult | null> {
  const row = await placeById(deps.db, id);
  if (row) return { place: toApiPlace(row, { full: true }), stored: true };
  if (!isDetailDue(await getMeta(deps.db, id), deps.now, id)) return null;
  if (!detailsAllowed(await detailGate(deps.db), deps.now)) return null;
  if (!(await deps.rateLimit())) return null;
  const r = await fetchPlaceDetail(deps.fetcher, id, { budget: new Budget(3), sleep: deps.sleep });
  if (!r.ok) {
    // 거점 격자에 없는 ID의 실패는 기록하지 않는다 — 아무 숫자로 D1을 키울 수 없게
    if (r.reason !== "budget" && (await isInTiles(deps.db, id, hubTileKeys()))) {
      await saveDetailFailure(deps.db, id, r.reason, deps.now);
    }
    if (BLOCK_SIGNALS.has(r.reason)) await recordPlaceBlock(deps.db, deps.now);
    return null;
  }
  // R38: 거점 격자 밖 ID(공유 링크, 예전 고리 격자)는 보여주기만 하고 저장하지 않는다 — Cron이 갱신하지 않는 행이 쌓이지 않게
  if (!(await isInTiles(deps.db, id, hubTileKeys()))) {
    return { place: toApiPlace(detailRow(id, r.summary, r.detail, deps.now), { full: true }), stored: false };
  }
  await saveDetail(deps.db, id, r.summary, r.detail, deps.now);
  const fresh = await placeById(deps.db, id);
  return fresh ? { place: toApiPlace(fresh, { full: true }), stored: true } : null;
}
