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
/** 이보다 오래된 저장본은 보여주지 않는다. 서버의 상세 유지 기간(DETAIL_OK_TTL_MS, 3일)과 같다 (스펙 §3.1을 보수적으로 읽음) */
export const PLACES_CACHE_MAX_AGE_MS = 3 * 24 * HOUR;

export type PlacesCacheEntry = { v: number; hub: string; savedAt: number; text: string };

/** 저장할 항목. 너무 크면 null */
export function placesCacheEntry(hub: string, text: string, now: number): PlacesCacheEntry | null {
  if (text.length === 0 || text.length > PLACES_CACHE_MAX_CHARS) return null;
  return { v: DEVICE_CACHE_VERSION, hub, savedAt: now, text };
}

export type CachedPlacesView = { text: string; savedAt: number; fresh: boolean };

/** 읽은 값이 이 거점의 쓸 수 있는 저장본이면 원문과 신선도. 모양·버전·거점이 틀리거나 너무 오래됐으면 null */
export function readPlacesCache(raw: unknown, hub: string, now: number): CachedPlacesView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Partial<PlacesCacheEntry>;
  if (e.v !== DEVICE_CACHE_VERSION || e.hub !== hub) return null;
  if (typeof e.text !== "string" || e.text.length === 0 || typeof e.savedAt !== "number") return null;
  const age = now - e.savedAt;
  // 기기 시계가 뒤로 갔으면(저장 시각이 미래) 오래된 것으로 친다
  if (age < 0 || age > PLACES_CACHE_MAX_AGE_MS) return null;
  return { text: e.text, savedAt: e.savedAt, fresh: age <= PLACES_CACHE_FRESH_MS };
}

/** 저장 뒤 지울 거점: 방금 저장한 거점은 남기고, 나머지는 최근 저장 순으로 MAX_HUBS개까지만 */
export function placesCacheEvictions(entries: { hub: string; savedAt: number }[], keep: string): string[] {
  const others = entries.filter((e) => e.hub !== keep).sort((a, b) => b.savedAt - a.savedAt);
  return others.slice(PLACES_CACHE_MAX_HUBS - 1).map((e) => e.hub);
}
