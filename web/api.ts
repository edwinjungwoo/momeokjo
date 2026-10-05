import type { ApiPlace, PlacesResponse } from "../shared/types";

/** R12: 거점 id + 50m 단위 반경 (화면은 R42로 항상 1000m). R45: 기기에 저장하려고 원문(text)도 준다 */
export async function fetchPlaces(
  hubId: string, radius: number, signal?: AbortSignal,
): Promise<{ data: PlacesResponse; text: string }> {
  const q = new URLSearchParams({ hub: hubId, radius: String(radius) });
  const res = await fetch(`/api/places?${q}`, { signal });
  if (!res.ok) throw new Error(`places ${res.status}`);
  const text = await res.text();
  return { data: JSON.parse(text) as PlacesResponse, text };
}

/** R13: 단일 가게. distance/walkMinutes가 없고 detail이 null일 수 있다 */
export async function fetchPlace(id: string, signal?: AbortSignal): Promise<ApiPlace> {
  const res = await fetch(`/api/places/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new Error(`place ${res.status}`);
  return res.json();
}
