import { lastLevel } from "./category";
import { MAX_RADIUS, MIN_RADIUS } from "./constants";
import type { Filters } from "./recommend";
import type { ApiPlace, LatLng } from "./types";

export function shareUrl(origin: string, id: string, center: LatLng, radius: number): string {
  const u = new URL("/", origin);
  u.searchParams.set("p", id);
  u.searchParams.set("lat", center.lat.toFixed(6));
  u.searchParams.set("lng", center.lng.toFixed(6));
  u.searchParams.set("r", String(radius));
  return u.toString();
}

export function shareText(p: ApiPlace, f: Filters, center: LatLng, origin: string): string {
  const who = f.party === 4 ? "4명+" : `${f.party}명`;
  const when = f.lunch ? `${f.lunch}분` : `반경 ${f.radius}m`;
  const rating = p.detail?.rating;
  const meta = [
    lastLevel(p.category),
    rating !== null && rating !== undefined ? `⭐${rating.toFixed(1)}` : null,
    p.walkMinutes !== undefined ? `도보 ${p.walkMinutes}분` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `🍚 ${who} · ${when} → ${p.name} 어때요?\n${meta}\n${shareUrl(origin, p.id, center, f.radius)}`;
}

export type ShareParams = { placeId: string | null; center: LatLng | null; radius: number | null };

export function parseShareParams(search: string): ShareParams {
  const q = new URLSearchParams(search);
  const p = q.get("p");
  const lat = Number(q.get("lat"));
  const lng = Number(q.get("lng"));
  const r = Number(q.get("r"));
  const validCenter = q.has("lat") && q.has("lng") && lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132;
  return {
    placeId: p && /^\d+$/.test(p) ? p : null,
    center: validCenter ? { lat, lng } : null,
    radius: q.has("r") && Number.isInteger(r) && r >= MIN_RADIUS && r <= MAX_RADIUS ? r : null,
  };
}
