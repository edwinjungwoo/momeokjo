import { SHOW_REFRESH_AFTER_MS, detailFingerprint, fpKind } from "../shared/adaptiveRefresh";
import { boundingBox, haversine, tilesCoveringCircle } from "../shared/geo";
import type { Hub } from "../shared/hubs";
import type { ApiPlace, LatLng } from "../shared/types";
import { Budget } from "./budget";
import type { DetailTally } from "./d1Usage";
import { BLOCK_SIGNALS, enrichDetails } from "./detailEnricher";
import type { FetchFn } from "./fetchFn";
import { readHubRefreshed } from "./hubRefresh";
import { hubTileKeys } from "./hubTiles";
import { fetchPlaceDetail } from "./kakaoPlace";
import { toApiPlace, withDistance, type PlacesMeta } from "./present";
import {
  countUnfetchedIn, detailGate, detailRow, detailsAllowed, frozenSince, getMeta, isInTiles, getTiles, isDetailDue, isTileDue,
  listRowsInBox, placeById, recordPlaceBlock, saveDetail, saveDetailFailure, tilePlaceStates, type ListRow, type PlaceRow,
  type TilePlaceState,
} from "./repo";
import { collectTiles } from "./tileCollector";

export type ServiceDeps = {
  db: D1Database;
  fetcher: FetchFn;
  restKey: string;
  budgetSize: number;
  batchSize: number;
  /** Task 34: 요청 뒤 보충이 풀 상세 JSON 글자 수 (없으면 기본값) */
  detailCharBudget?: number;
  now: number;
  rateLimit: () => Promise<boolean>;
  waitUntil: (p: Promise<unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  /** R52: 읽기 전용(개발 서버가 운영 D1에 붙을 때) — 격자 수집·상세 보충·상세 저장을 하지 않는다 */
  readOnly?: boolean;
  /** R66: 저장한 상세의 같음·바뀜·처음 계수 (요청 미들웨어가 사용량 기록 문장에 같이 더한다) */
  tally?: DetailTally;
};

/** R12 응답: 메타 필드 + 거리순 목록 원소 JSON 조각 (본문은 present.ts placesBody로 이어 붙인다) */
export type PlacesPayload = PlacesMeta & { items: string[] };

/** 격자-장소 상태와 반경 안 목록 행(거리순) — 요청 경로(getPlaces)와 R56 스냅샷 만들기가 같은 읽기를 쓴다 */
export type ListRead = { tileStates: TilePlaceState[]; rows: { row: ListRow; d: number }[] };

/**
 * D1만 읽는다 (수집·보충 없음). 격자-장소 상태는 한 번만 읽어서 목록 필터·pending·보충 대상 고르기에 같이 쓴다.
 * 거리가 같으면 id순 — D1이 행을 주는 순서와 상관없이 같은 데이터면 같은 본문 (같은 건물의 가게는 좌표가 같다)
 */
export async function readList(db: D1Database, center: LatLng, radiusM: number, keys: string[]): Promise<ListRead> {
  const tileStates = await tilePlaceStates(db, keys);
  return { tileStates, rows: await readListRows(db, center, radiusM, tileStates) };
}

/** 이미 읽은 격자-장소 상태로 반경 안 목록 행만 읽는다 (R56 스냅샷은 pending을 먼저 보고 필요할 때만 부른다) */
export async function readListRows(
  db: D1Database, center: LatLng, radiusM: number, tileStates: TilePlaceState[],
): Promise<ListRead["rows"]> {
  const inTiles = new Set(tileStates.map((t) => t.id));
  // 미리 만든 목록 원소 조각(list_json)을 쓴다 — 행마다 JSON 열 4개를 parse·stringify하지 않는다 (0005)
  return (await listRowsInBox(db, boundingBox(center, radiusM), inTiles))
    .filter((r) => r.group !== "dessert")
    .map((row) => ({ row, d: haversine(center, row) }))
    .filter((x) => x.d <= radiusM)
    .sort((a, b) => a.d - b.d || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
}

/** 응답 메타 중 실행마다 정하는 것 (나머지 center·radius·detailsNewestAt은 placesPayload가 채운다). R63 두 값은 서버가 언제나 싣는다 */
export type PlacesState = Pick<PlacesMeta, "pending" | "incompleteTiles" | "stale" | "detailsPaused" | "detailsFrozenSince"> & {
  refreshedAt: number | null;
  refreshDay: number;
};

/** 응답을 만든다. 키 순서가 본문 글자를 정한다 — 요청 경로와 스냅샷이 이 함수 하나를 쓴다 */
export function placesPayload(center: LatLng, radiusM: number, rows: ListRead["rows"], s: PlacesState): PlacesPayload {
  // R44: 실린 가게 중 가장 최근에 상세를 가져온 시각 (실패 기록 시각은 빼고)
  let newest: number | null = null;
  for (const x of rows) if (x.row.status === "ok" && (newest === null || x.row.fetchedAt > newest)) newest = x.row.fetchedAt;
  return {
    center: { lat: center.lat, lng: center.lng },
    radius: radiusM,
    items: rows.map((x) => withDistance(x.row.json, x.d)),
    pending: s.pending,
    incompleteTiles: s.incompleteTiles,
    stale: s.stale,
    detailsPaused: s.detailsPaused,
    detailsFrozenSince: s.detailsFrozenSince,
    detailsNewestAt: newest,
    // R63: 거점 갱신 완료 시각과 요일 (본문 맨 뒤)
    refreshedAt: s.refreshedAt,
    refreshDay: s.refreshDay,
  };
}

/** 거점 목록 (R12). R63: 응답에 그 거점의 갱신 요일과 마지막 완료 시각(meta hub_refreshed, 1행)을 싣는다 */
export async function getPlaces(
  deps: ServiceDeps, hub: Hub, radiusM: number,
): Promise<PlacesPayload | { error: "upstream" }> {
  const center = { lat: hub.lat, lng: hub.lng };
  const keys = tilesCoveringCircle(center, radiusM);
  const states = await getTiles(deps.db, keys);
  const due = keys.filter((k) => isTileDue(k, states.get(k), deps.now));
  const budget = new Budget(deps.budgetSize);

  let allowed: boolean | null = null;
  const allow = async () => (allowed ??= await deps.rateLimit());

  let incompleteTiles = 0;
  let failedTiles = 0;
  let stale = false;
  // R52: 읽기 전용이면 만료된 격자도 저장된 그대로 쓴다 (수집은 운영 Cron 몫 — incompleteTiles로 세지 않아 화면이 다시 부르지 않는다)
  if (due.length > 0 && !deps.readOnly) {
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

  const { tileStates, rows } = await readList(deps.db, center, radiusM, keys);

  if (failedTiles > 0 && rows.length === 0) return { error: "upstream" };

  // 보충(waitUntil)이 시작되기 전에 센다 — 응답과 보충이 섞이지 않게.
  // 요청 시점에는 한 번도 가져오지 않은 장소만 보충한다. 만료된 상세 갱신은 Cron(R11) 몫이다.
  const pending = countUnfetchedIn(tileStates);
  // R10 쿨다운·R44 강등 모드 (meta 2행). frozen이면 응답에 시작 시각을 싣는다
  const gate = await detailGate(deps.db);
  // R52: 읽기 전용이면 상세 보충도 멈춘 것으로 알린다 (pending이 줄지 않으니 화면이 폴링하지 않게)
  const detailsPaused = deps.readOnly === true || !detailsAllowed(gate, deps.now);
  // 요청 제한에 걸리면 보충만 건너뛴다 (pending은 그대로, stale 아님)
  if (pending > 0 && !detailsPaused && budget.left > 0 && (await allow())) {
    deps.waitUntil(
      enrichDetails(
        {
          db: deps.db, fetcher: deps.fetcher, budget, now: deps.now, batchSize: deps.batchSize, sleep: deps.sleep,
          scope: "unfetched", candidates: tileStates, charBudget: deps.detailCharBudget, tally: deps.tally,
        },
        center,
        radiusM,
      )
        .then((r) => {
          if (r.error !== undefined) console.error("enrich failed", r.error);
        })
        .catch((e) => console.error("enrich failed", e)),
    );
  }

  const refreshed = await readHubRefreshed(deps.db, hub.id);
  return placesPayload(center, radiusM, rows, {
    pending, incompleteTiles, stale, detailsPaused, detailsFrozenSince: frozenSince(gate, deps.now),
    refreshedAt: refreshed?.start ?? null, refreshDay: hub.refreshDay,
  });
}

/** R13 단건: stored=false면 거점 격자 밖 id라 D1에 저장하지 않고 보여주기만 한 응답 (app.ts가 엣지에 잠깐 둔다) */
export type PlaceResult = { place: ApiPlace; stored: boolean };
/**
 * 없음(404). cacheable이면 거점 격자 밖 id의 상세를 실제로 받으려다 실패한 것이라(없음·http 오류·스키마) app.ts가
 * 엣지에 잠깐 둔다. 쿨다운·요청 제한·호출 예산·차단 신호처럼 일시적인 이유나 거점 격자 안 id(D1에 실패를 기록한다)는 아니다.
 */
export type PlaceMiss = { place: null; cacheable: boolean };

export async function getPlace(deps: ServiceDeps, id: string): Promise<PlaceResult | PlaceMiss> {
  const row = await placeById(deps.db, id);
  if (row) {
    refreshOnShow(deps, row);
    return { place: toApiPlace(row, { full: true }), stored: true };
  }
  if (!isDetailDue(await getMeta(deps.db, id), deps.now, id)) return { place: null, cacheable: false };
  if (!detailsAllowed(await detailGate(deps.db), deps.now)) return { place: null, cacheable: false };
  if (!(await deps.rateLimit())) return { place: null, cacheable: false };
  const r = await fetchPlaceDetail(deps.fetcher, id, { budget: new Budget(3), sleep: deps.sleep });
  // R52: 읽기 전용이면 성공은 보여주기만 하고(거점 격자 밖 id처럼), 실패·차단 신호도 기록하지 않는다
  if (deps.readOnly) {
    return r.ok
      ? { place: toApiPlace(detailRow(id, r.summary, r.detail, deps.now), { full: true }), stored: false }
      : { place: null, cacheable: false };
  }
  if (!r.ok) {
    // 거점 격자에 없는 ID의 실패는 기록하지 않는다 — 아무 숫자로 D1을 키울 수 없게
    const inTiles = r.reason !== "budget" && (await isInTiles(deps.db, id, hubTileKeys()));
    if (inTiles) await saveDetailFailure(deps.db, id, r.reason, deps.now);
    const blocked = BLOCK_SIGNALS.has(r.reason);
    if (blocked) await recordPlaceBlock(deps.db, deps.now);
    return { place: null, cacheable: r.reason !== "budget" && !blocked && !inTiles };
  }
  // R38: 거점 격자 밖 ID(공유 링크, 예전 고리 격자)는 보여주기만 하고 저장하지 않는다 — Cron이 갱신하지 않는 행이 쌓이지 않게
  if (!(await isInTiles(deps.db, id, hubTileKeys()))) {
    return { place: toApiPlace(detailRow(id, r.summary, r.detail, deps.now), { full: true }), stored: false };
  }
  const fp = detailFingerprint(r.summary, r.detail);
  await saveDetail(deps.db, id, r.summary, r.detail, deps.now, { fp });
  // 표시 정보가 있는 행이 없었다 = 한 번도 성공하지 못한 곳 (지난 지문 없음)
  if (deps.tally) deps.tally[fpKind(null, fp)] += 1;
  const fresh = await placeById(deps.db, id);
  return fresh ? { place: toApiPlace(fresh, { full: true }), stored: true } : { place: null, cacheable: false };
}

/** R66: 이 isolate에서 지금 다시 가져오는 중인 가게 (같은 가게를 동시에 두 번 부르지 않는다) */
const showRefreshing = new Set<string>();

/**
 * R66 볼 때 신선하게 (stale-while-revalidate): 저장된 ok 가게를 열었는데 상세가 SHOW_REFRESH_AFTER_MS(7일)보다 오래됐으면
 * 응답은 저장된 그대로 주고, 응답 뒤(waitUntil)에 그 한 곳만 다시 가져온다. R52 읽기 전용이면 하지 않는다.
 * 뒤 작업: R10 쿨다운·R44 frozen이면 그만, R15 요청 제한, 외부 호출 예산 Budget(3)(상세 한 곳 — 재시도 포함), 저장은 Cron과 같다
 * (스냅샷 표시 R56 같은 batch, 실패는 실패 기록, 403·429는 쿨다운) — 다만 주기는 지문과 상관없이 1주(사람들이 여는 가게는 매주 본다).
 */
function refreshOnShow(deps: ServiceDeps, row: PlaceRow): void {
  const id = row.place.id;
  if (deps.readOnly || row.meta.status !== "ok" || deps.now - row.meta.fetchedAt <= SHOW_REFRESH_AFTER_MS) return;
  if (showRefreshing.has(id)) return;
  showRefreshing.add(id);
  deps.waitUntil(
    refreshShown(deps, id, row.fp ?? null)
      .catch((e) => console.error("show refresh failed", id, e))
      .finally(() => showRefreshing.delete(id)),
  );
}

async function refreshShown(deps: ServiceDeps, id: string, prevFp: string | null): Promise<void> {
  if (!detailsAllowed(await detailGate(deps.db), deps.now)) return;
  if (!(await deps.rateLimit())) return;
  const r = await fetchPlaceDetail(deps.fetcher, id, { budget: new Budget(3), sleep: deps.sleep });
  if (!r.ok) {
    if (r.reason !== "budget") await saveDetailFailure(deps.db, id, r.reason, deps.now);
    if (BLOCK_SIGNALS.has(r.reason)) await recordPlaceBlock(deps.db, deps.now);
    return;
  }
  const fp = detailFingerprint(r.summary, r.detail);
  await saveDetail(deps.db, id, r.summary, r.detail, deps.now, { fp, weekly: true });
  if (deps.tally) deps.tally[fpKind(prevFp, fp)] += 1;
}
