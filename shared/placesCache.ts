/**
 * R45 다시 열면 바로: 거점마다 마지막 /api/places 응답(원문 JSON)을 기기(IndexedDB)에 두고, 열자마자 먼저 보여준 뒤
 * 뒤에서 새로 받아 바꾼다. 여기는 저장 형식과 판단만 둔다 (저장소 접근은 web/placesCache.ts).
 */
const HOUR = 3600_000;

/** 기기 저장본 형식 버전 — 응답 모양이 바뀌면 올린다 (예전 항목은 읽지 않고, 다음 저장에서 덮인다). Worker 엣지 캐시의 PLACES_CACHE_VERSION과는 따로다 */
export const DEVICE_CACHE_VERSION = 1;
/** 기기에 두는 거점 수 (가장 최근에 저장한 것부터) */
export const PLACES_CACHE_MAX_HUBS = 3;
/** 한 거점 응답 원문의 최대 길이 (1000m 목록은 0.6~1.0MB). 넘으면 저장하지 않는다 */
export const PLACES_CACHE_MAX_CHARS = 3_000_000;
/** 이보다 오래된 저장본은 흐리게 보여주고, 자동 뽑기는 새 목록을 기다린다 */
export const PLACES_CACHE_FRESH_MS = 24 * HOUR;
/**
 * 이보다 오래된 저장본은 보여주지 않는다 (스펙 §3.1을 보수적으로 읽음). 예전 서버 상세 유지 기간(3일)에 맞춘 값이고,
 * R63 주 1회 갱신 뒤에도 그대로 둔다 — 기기 저장본은 서버보다 짧게 쓴다
 */
export const PLACES_CACHE_MAX_AGE_MS = 3 * 24 * HOUR;

/** R56: 저장본과 함께 두는 응답 ETag의 최대 길이 (서버 ETag는 40자 안팎) */
const ETAG_MAX_CHARS = 200;
const validEtag = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= ETAG_MAX_CHARS;
/** 저장해 둔 ETag 값이 쓸 만하면 그 값, 아니면 null */
export const usableEtag = (v: unknown): string | null => (validEtag(v) ? v : null);

/** etag: R56 서버 스냅샷 응답의 ETag (없던 예전 저장본은 키가 없다 — 판을 올리지 않아도 읽힌다) */
export type PlacesCacheEntry = { v: number; hub: string; savedAt: number; text: string; etag?: string };

/** 저장할 항목. 너무 크면 null */
export function placesCacheEntry(hub: string, text: string, now: number, etag?: string | null): PlacesCacheEntry | null {
  if (text.length === 0 || text.length > PLACES_CACHE_MAX_CHARS) return null;
  return { v: DEVICE_CACHE_VERSION, hub, savedAt: now, text, ...(validEtag(etag) ? { etag } : {}) };
}

/** etag가 있으면 다시 열 때 If-None-Match로 보낸다 (R56: 바뀐 게 없으면 304 — 본문을 받지 않는다) */
export type CachedPlacesView = { text: string; savedAt: number; fresh: boolean; etag?: string };

/** 읽은 값이 이 거점의 쓸 수 있는 저장본이면 원문과 신선도. 모양·버전·거점이 틀리거나 너무 오래됐으면 null */
export function readPlacesCache(raw: unknown, hub: string, now: number): CachedPlacesView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Partial<PlacesCacheEntry>;
  if (e.v !== DEVICE_CACHE_VERSION || e.hub !== hub) return null;
  if (typeof e.text !== "string" || e.text.length === 0 || typeof e.savedAt !== "number") return null;
  const age = now - e.savedAt;
  // 기기 시계가 뒤로 갔으면(저장 시각이 미래) 오래된 것으로 친다
  if (age < 0 || age > PLACES_CACHE_MAX_AGE_MS) return null;
  return { text: e.text, savedAt: e.savedAt, fresh: age <= PLACES_CACHE_FRESH_MS, ...(validEtag(e.etag) ? { etag: e.etag } : {}) };
}

/** 저장 뒤 지울 거점: 방금 저장한 거점은 남기고, 나머지는 최근 저장 순으로 MAX_HUBS개까지만 */
export function placesCacheEvictions(entries: { hub: string; savedAt: number }[], keep: string): string[] {
  const others = entries.filter((e) => e.hub !== keep).sort((a, b) => b.savedAt - a.savedAt);
  return others.slice(PLACES_CACHE_MAX_HUBS - 1).map((e) => e.hub);
}

/** 화면 상태 중 저장본을 합칠 때 보는 부분 (data의 모양은 여기서 보지 않는다) */
export type PlacesMergeState<D> = {
  data: D | null;
  /** data가 어느 거점 목록인가 */
  hub: string | null;
  /** data가 기기 저장본이면 저장 시각과 신선도 (새로 받은 목록이면 null) */
  cache: { savedAt: number; fresh: boolean } | null;
  loading: boolean;
  error: boolean;
  polling: boolean;
};

/**
 * 뒤늦게 읽힌 저장본을 화면 상태에 합친다.
 * - 이 거점의 새 목록을 이미 들고 있으면(저장본보다 네트워크가 먼저 온 경우, 다시 시도) 저장본은 버린다.
 * - 아니면 저장본을 보여준다. 거점이 다른 이전 목록은 이 거점의 저장본으로 바뀐다.
 *   네트워크가 먼저 실패했으면(error) 그 상태는 그대로 두어 "불러오지 못했어요"가 저장본과 함께 보인다.
 * - 하루 넘은 저장본은 새 목록이 올 때까지 loading(흐리게)을 유지하고, 신선하면 끈다.
 */
export function mergeCachedPlaces<D, S extends PlacesMergeState<D>>(
  s: S,
  hub: string,
  cached: { data: D; savedAt: number; fresh: boolean },
): S {
  if (s.data !== null && s.hub === hub && s.cache === null) return s;
  return {
    ...s,
    data: cached.data,
    hub,
    cache: { savedAt: cached.savedAt, fresh: cached.fresh },
    loading: s.loading && !cached.fresh,
    polling: false,
  };
}
