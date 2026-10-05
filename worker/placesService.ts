import { PLACE_BLOCK_COOLDOWN_MS } from "../shared/constants";
import { boundingBox, haversine, tilesCoveringCircle } from "../shared/geo";
import type { ApiPlace, LatLng, PlacesResponse } from "../shared/types";
import { Budget } from "./budget";
import { BLOCK_SIGNALS, enrichDetails } from "./detailEnricher";
import type { FetchFn } from "./fetchFn";
import { fetchPlaceDetail } from "./kakaoPlace";
import { toApiPlace } from "./present";
import {
  blockPlaceApi, countUnfetched, getMeta, getTiles, isDetailDue, isTileDue, placeBlockedUntil, placeById,
  placesInBox, saveDetail, saveDetailFailure,
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
        { db: deps.db, fetcher: deps.fetcher, restKey: deps.restKey, budget, now: deps.now }, due,
      );
      incompleteTiles = r.incomplete.length;
      failedTiles = r.failed.length;
      stale = failedTiles > 0;
    } else {
      incompleteTiles = due.length;
      stale = true;
    }
  }

  const rows = (await placesInBox(deps.db, boundingBox(center, radiusM)))
    .filter((r) => r.place.group !== "dessert")
    .map((row) => ({ row, d: haversine(center, row.place) }))
    .filter((x) => x.d <= radiusM)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.row);

  if (failedTiles > 0 && rows.length === 0) return { error: "upstream" };

  // 보충(waitUntil)이 시작되기 전에 센다 — 응답과 보충이 섞이지 않게.
  // 요청 시점에는 한 번도 가져오지 않은 장소만 보충한다. 만료된 상세 갱신은 Cron(R11) 몫이다.
  const pending = await countUnfetched(deps.db, keys);
  const needsDetail = pending > 0 && deps.now >= (await placeBlockedUntil(deps.db));
  if (needsDetail && budget.left > 0 && (await allow())) {
    deps.waitUntil(
      enrichDetails(
        {
          db: deps.db, fetcher: deps.fetcher, budget, now: deps.now, batchSize: deps.batchSize, sleep: deps.sleep,
          scope: "unfetched",
        },
        center,
        radiusM,
      ).catch((e) => console.error("enrich failed", e)),
    );
  } else if (needsDetail && allowed === false) {
    stale = true;
  }

  return {
    center,
    radius: radiusM,
    places: rows.map((r) => toApiPlace(r, { center })),
    pending,
    incompleteTiles,
    stale,
  };
}

export async function getPlace(deps: ServiceDeps, id: string): Promise<ApiPlace | null> {
  const row = await placeById(deps.db, id);
  if (row) return toApiPlace(row, { full: true });
  if (!isDetailDue(await getMeta(deps.db, id), deps.now, id)) return null;
  if (deps.now < (await placeBlockedUntil(deps.db))) return null;
  if (!(await deps.rateLimit())) return null;
  const r = await fetchPlaceDetail(deps.fetcher, id, { budget: new Budget(3), sleep: deps.sleep });
  if (!r.ok) {
    if (r.reason !== "budget") await saveDetailFailure(deps.db, id, r.reason, deps.now);
    if (BLOCK_SIGNALS.has(r.reason)) await blockPlaceApi(deps.db, deps.now + PLACE_BLOCK_COOLDOWN_MS);
    return null;
  }
  await saveDetail(deps.db, id, r.summary, r.detail, deps.now);
  const fresh = await placeById(deps.db, id);
  return fresh ? toApiPlace(fresh, { full: true }) : null;
}
