import { lastLevel } from "./category";
import { haversine } from "./geo";
import { PUBLIC_HUBS, type Hub } from "./hubs";
import { PREFERENCE_KINDS, SIGNAL_TTL_MS, type PersonalState } from "./personal";
import type { LatLng } from "./types";

/**
 * R65 "내 가게": 기기에 남은 것(즐겨찾기·최근 카카오맵/공유·뺀 곳, 이름 기억)만으로 세 묶음을 만든다 — 서버는 부르지 않는다.
 */
export const MAX_RECENT = 20;
/** 줄 설명의 "{역} 근처" — 이 거리 안의 가장 가까운 공개 역 */
export const NEAR_HUB_LABEL_M = 1200;
/** 지금 목록에 없는 곳을 누르면 이 거리 안의 공개 역으로 옮겨서 연다 (거점 목록은 1000m) */
export const NEAR_HUB_MOVE_M = 1000;

const FALLBACK_FAVORITE = "즐겨찾기한 가게";
const FALLBACK_EXCLUDED = "이전에 뺀 가게";

/** pos: 거점을 고르는 데 쓰는 좌표 (모르면 null) */
export type MineItem = { id: string; name: string; line: string; pos: LatLng | null };
export type MineSections = { favorites: MineItem[]; recent: MineItem[]; excluded: MineItem[] };
/** 지금 받아 둔 거점 목록에 있는 가게 (ApiPlace의 일부) */
export type LivePlace = { name: string; category: string; lat: number; lng: number };

/** R62: 공개 역 중 maxM 안에서 가장 가까운 곳 */
export function nearestHub(p: LatLng, maxM: number): Hub | null {
  let best: Hub | null = null;
  let bestM = Infinity;
  for (const h of PUBLIC_HUBS) {
    const m = haversine(p, h);
    if (m <= maxM && m < bestM) {
      best = h;
      bestM = m;
    }
  }
  return best;
}

/** "{세부 종류} · {가까운 공개 역} 근처" — 모르는 쪽은 뺀다 */
export function placeLine(cat: string | undefined, pos: LatLng | null): string {
  const hub = pos ? nearestHub(pos, NEAR_HUB_LABEL_M) : null;
  return [cat || null, hub ? `${hub.name} 근처` : null].filter(Boolean).join(" · ");
}

const byNewest = (m: Record<string, number>): string[] =>
  Object.entries(m).sort((a, b) => b[1] - a[1]).map(([id]) => id);

export const favoriteIds = (s: PersonalState): string[] => byNewest(s.favorites);
export const excludedIds = (s: PersonalState): string[] => byNewest(s.excluded);

/**
 * 최근 열어 본 곳: 30일 안에 카카오맵을 열었거나 공유한 곳, 마지막으로 한 때가 최근인 것부터 한 번씩, 최대 20곳.
 * 즐겨찾기·뺀 곳은 그 묶음에 있으니 뺀다. known이 false인 곳(이름을 모름)은 건너뛰고 다음 곳으로 채운다
 */
export function recentIds(s: PersonalState, now: number, known: (id: string) => boolean = () => true): string[] {
  const last = new Map<string, number>();
  for (const x of s.signals) {
    if (!PREFERENCE_KINDS.has(x.kind) || now - x.at > SIGNAL_TTL_MS) continue;
    if (Object.hasOwn(s.favorites, x.id) || Object.hasOwn(s.excluded, x.id)) continue;
    last.set(x.id, Math.max(last.get(x.id) ?? -Infinity, x.at));
  }
  return [...last].sort((a, b) => b[1] - a[1]).map(([id]) => id).filter(known).slice(0, MAX_RECENT);
}

/**
 * 세 묶음. 이름·설명은 지금 목록(live — 가장 새 정보) → 기억한 이름 순으로 찾는다.
 * 둘 다 없으면 즐겨찾기 "즐겨찾기한 가게", 뺀 곳 "이전에 뺀 가게"(이 기능 전에 뺀 곳), 최근 곳은 보여줄 수 없어 건너뛴다
 */
export function mineSections(s: PersonalState, now: number, live: (id: string) => LivePlace | undefined): MineSections {
  const item = (id: string, fallback: string): MineItem => {
    const l = live(id);
    if (l) {
      const pos = { lat: l.lat, lng: l.lng };
      return { id, name: l.name, line: placeLine(lastLevel(l.category) || undefined, pos), pos };
    }
    const snap = s.snapshots[id];
    if (snap) {
      const pos = { lat: snap.lat, lng: snap.lng };
      return { id, name: snap.name, line: placeLine(snap.cat, pos), pos };
    }
    return { id, name: fallback, line: "", pos: null };
  };
  const known = (id: string) => live(id) !== undefined || Object.hasOwn(s.snapshots, id);
  return {
    favorites: favoriteIds(s).map((id) => item(id, FALLBACK_FAVORITE)),
    recent: recentIds(s, now, known).map((id) => item(id, "")),
    excluded: excludedIds(s).map((id) => item(id, FALLBACK_EXCLUDED)),
  };
}
