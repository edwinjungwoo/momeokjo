import { lastLevel } from "./category";
import { isValidRadius } from "./constants";
import { hubById, isHubId } from "./hubs";
import type { Filters } from "./recommend";
import type { ApiPlace } from "./types";

const PLACE_ID = /^\d{1,15}$/;
const MAX_SHARED = 3;

/** R23′/R43: /{거점 id}?t={id1},{id2},{id3}&r={반경}. id는 숫자, 거점 id는 URL에 안전한 글자라 쉼표를 그대로 둔다 */
export function shareUrl(origin: string, ids: string[], hubId: string, radius: number): string {
  const base = new URL(`/${encodeURIComponent(hubId)}`, origin).toString();
  return `${base}?t=${ids.join(",")}&r=${radius}`;
}

/** R43: 경로가 정확히 /{거점 id}(끝 / 허용)이면 그 거점 id, 아니면 null */
export function parseHubPath(pathname: string): string | null {
  const m = /^\/([a-z0-9-]+)\/?$/.exec(pathname);
  return m && isHubId(m[1]) ? m[1] : null;
}

function line(p: ApiPlace, i: number): string {
  const rating = p.detail?.rating;
  return [
    `${i + 1}. ${p.name}`,
    lastLevel(p.category) || null,
    rating !== null && rating !== undefined ? `★${rating.toFixed(1)}` : null,
    p.walkMinutes !== undefined ? `도보 ${p.walkMinutes}분` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** R23′: 뽑힌 후보(최대 3곳)를 한 번에 제안하는 공유 문구 */
export function shareText(places: ApiPlace[], f: Filters, hubId: string, origin: string): string {
  const who = f.party === 4 ? "4명+" : `${f.party}명`;
  const ask = places.length === 1 ? "여기 어때요?" : "이 중에 어디 갈래요?";
  return [
    `🍚 점심 고? (${who} · ${hubById(hubId).name} 반경 ${f.radius}m)`,
    ...places.map(line),
    `${ask} 👉 ${shareUrl(origin, places.map((p) => p.id), hubId, f.radius)}`,
  ].join("\n");
}

export type ShareParams = { placeIds: string[]; hubId: string | null; radius: number | null };

/**
 * t(쉼표로 이은 id 1~3개)를 읽고, 없으면 예전 p(1개)를 읽는다. 예전 링크의 lat/lng는 무시한다.
 * 거점은 경로(R43)가 우선이고, 없으면 예전 h를 읽는다.
 */
export function parseShareParams(search: string, pathname = "/"): ShareParams {
  const q = new URLSearchParams(search);
  const fromT = [...new Set((q.get("t") ?? "").split(",").filter((id) => PLACE_ID.test(id)))].slice(0, MAX_SHARED);
  const p = q.get("p");
  const h = q.get("h");
  const r = Number(q.get("r"));
  return {
    placeIds: fromT.length > 0 ? fromT : p && PLACE_ID.test(p) ? [p] : [],
    hubId: parseHubPath(pathname) ?? (isHubId(h) ? h : null),
    radius: q.has("r") && isValidRadius(r) ? r : null,
  };
}
