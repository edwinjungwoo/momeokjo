import type { ApiPlace, LatLng, PlacesResponse } from "../shared/types";

export async function fetchPlaces(center: LatLng, radius: number, signal?: AbortSignal): Promise<PlacesResponse> {
  const q = new URLSearchParams({ lat: center.lat.toFixed(6), lng: center.lng.toFixed(6), radius: String(radius) });
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
