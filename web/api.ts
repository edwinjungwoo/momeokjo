import type { ApiPlace, PlacesResponse } from "../shared/types";

/** R12: 거점 id + 50m 단위 반경 */
export async function fetchPlaces(hubId: string, radius: number, signal?: AbortSignal): Promise<PlacesResponse> {
  const q = new URLSearchParams({ hub: hubId, radius: String(radius) });
  const res = await fetch(`/api/places?${q}`, { signal });
  if (!res.ok) throw new Error(`places ${res.status}`);
  return res.json();
}

/** R13: 단일 가게. distance/walkMinutes가 없고 detail이 null일 수 있다 */
export async function fetchPlace(id: string): Promise<ApiPlace> {
  const res = await fetch(`/api/places/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`place ${res.status}`);
  return res.json();
}
