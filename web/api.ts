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

/** R13: 단일 가게. distance/walkMinutes가 없고 detail이 null일 수 있다 */
export async function fetchPlace(id: string, signal?: AbortSignal): Promise<ApiPlace> {
  const res = await fetch(`/api/places/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`place ${res.status}`);
  return res.json();
}
