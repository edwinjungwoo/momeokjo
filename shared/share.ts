import { lastLevel } from "./category";
import { isValidRadius } from "./constants";
import { isHubId } from "./hubs";
import type { Filters } from "./recommend";
import type { ApiPlace } from "./types";

/** R23: ?p={장소 id}&h={거점 id}&r={반경} */
export function shareUrl(origin: string, id: string, hubId: string, radius: number): string {
  const u = new URL("/", origin);
  u.searchParams.set("p", id);
  u.searchParams.set("h", hubId);
  u.searchParams.set("r", String(radius));
  return u.toString();
}

export function shareText(p: ApiPlace, f: Filters, hubId: string, origin: string): string {
  const who = f.party === 4 ? "4명+" : `${f.party}명`;
  const rating = p.detail?.rating;
  const meta = [
    lastLevel(p.category),
    rating !== null && rating !== undefined ? `⭐${rating.toFixed(1)}` : null,
    p.walkMinutes !== undefined ? `도보 ${p.walkMinutes}분` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `🍚 ${who} · 반경 ${f.radius}m → ${p.name} 어때요?\n${meta}\n${shareUrl(origin, p.id, hubId, f.radius)}`;
}

export type ShareParams = { placeId: string | null; hubId: string | null; radius: number | null };

/** 예전 링크의 lat/lng는 무시한다 */
export function parseShareParams(search: string): ShareParams {
  const q = new URLSearchParams(search);
  const p = q.get("p");
  const h = q.get("h");
  const r = Number(q.get("r"));
  return {
    placeId: p && /^\d{1,15}$/.test(p) ? p : null,
    hubId: isHubId(h) ? h : null,
    radius: q.has("r") && isValidRadius(r) ? r : null,
  };
}
