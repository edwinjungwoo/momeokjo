import type { ApiPlace, PlacesResponse } from "../shared/types";

export type PlacesFetch =
  | { notModified: true }
  | { notModified: false; data: PlacesResponse; text: string; etag: string | null };

/**
 * R12: 거점 id + 50m 단위 반경 (화면은 R42로 항상 1000m). R45: 기기에 저장하려고 원문(text)도 준다.
 * R56: 기기 저장본의 ETag(etag)를 주면 If-None-Match로 보낸다 — 서버 스냅샷이 같으면 304(본문 없음)이라 notModified.
 * 응답의 ETag를 돌려준다 (스냅샷이 아닌 응답은 null).
 */
export async function fetchPlaces(
  hubId: string, radius: number, signal?: AbortSignal, etag?: string | null,
): Promise<PlacesFetch> {
  const q = new URLSearchParams({ hub: hubId, radius: String(radius) });
  const res = await fetch(`/api/places?${q}`, { signal, ...(etag ? { headers: { "if-none-match": etag } } : {}) });
  if (res.status === 304 && etag) return { notModified: true };
  if (!res.ok) throw new Error(`places ${res.status}`);
  const text = await res.text();
  return { notModified: false, data: JSON.parse(text) as PlacesResponse, text, etag: res.headers.get("etag") };
}

export type PlacesLoaded = { data: PlacesResponse; text: string; etag: string | null; fromCopy: boolean };
type DeviceCopy = { data: PlacesResponse; text: string; etag?: string } | null;

/**
 * R56 다시 열 때: 기기 저장본의 ETag(작은 키에서 바로 읽은 값)로 곧바로 요청한다 — 저장본(~1MB)을 읽고 해석하기를 기다리지 않는다.
 * 304면 그때 저장본을 받아(copy) ETag가 같은지 보고 새 목록으로 쓴다(fromCopy). 저장본이 없거나 ETag가 다르면 조건 없이 다시 받는다
 */
export async function loadPlaces(
  hubId: string, radius: number, signal: AbortSignal | undefined, etag: string | null, copy: () => Promise<DeviceCopy>,
): Promise<PlacesLoaded> {
  const r = await fetchPlaces(hubId, radius, signal, etag);
  if (!r.notModified) return { data: r.data, text: r.text, etag: r.etag, fromCopy: false };
  const c = await copy();
  if (c && c.etag === etag) return { data: c.data, text: c.text, etag, fromCopy: true };
  const again = await fetchPlaces(hubId, radius, signal, null);
  if (again.notModified) throw new Error("places 304 without If-None-Match");
  return { data: again.data, text: again.text, etag: again.etag, fromCopy: false };
}

/** R13: 단일 가게. distance/walkMinutes가 없고 detail이 null일 수 있다 */
export async function fetchPlace(id: string, signal?: AbortSignal): Promise<ApiPlace> {
  const res = await fetch(`/api/places/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`place ${res.status}`);
  return res.json();
}
