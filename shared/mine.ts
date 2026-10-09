import { lastLevel } from "./category";
import { haversine } from "./geo";
import { PUBLIC_HUBS, type Hub } from "./hubs";
import { PREFERENCE_KINDS, SIGNAL_TTL_MS, freshSnapshot, type PersonalState } from "./personal";
import type { LatLng } from "./types";

/**
 * R65 "내 가게": 기기에 남은 것(즐겨찾기·최근 카카오맵/공유·뺀 곳의 id와 시각, 3일 안의 이름 기억)으로 세 묶음을 만든다.
 * 이름을 모르는 곳(3일 지남·이 기능 전)은 시트를 열 때 단건(R13)으로 다시 불러온다 (unresolvedIds, App)
 */
export const MAX_RECENT = 20;
/** 시트를 한 번 열 때 다시 불러오는 최대 수 */
export const MAX_RESOLVE = 30;
/** 줄 설명의 "{역} 근처" — 이 거리 안의 가장 가까운 공개 역 */
export const NEAR_HUB_LABEL_M = 1200;
/** 지금 목록에 없는 곳을 누르면 이 거리 안의 공개 역으로 옮겨서 연다 (거점 목록은 1000m) */
export const NEAR_HUB_MOVE_M = 1000;

const FALLBACK_KEPT = "이전에 담은 가게";
const FALLBACK_EXCLUDED = "이전에 뺀 가게";

/** pos: 거점을 고르는 데 쓰는 좌표 (모르면 null). loading: 이름을 다시 불러오는 중 (name은 빈 글자 — 화면은 뼈대) */
export type MineItem = { id: string; name: string; line: string; pos: LatLng | null; loading: boolean };
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

/** 뺀 곳이기도 하면(예전 저장값) 뺀 곳에만 보인다 */
export const favoriteIds = (s: PersonalState): string[] => byNewest(s.favorites).filter((id) => !Object.hasOwn(s.excluded, id));
export const excludedIds = (s: PersonalState): string[] => byNewest(s.excluded);

/** 최근 열어 본 곳과 그 마지막 시각 (최근 것부터) */
function recentTimes(s: PersonalState, now: number): [string, number][] {
  const last = new Map<string, number>();
  for (const x of s.signals) {
    if (!PREFERENCE_KINDS.has(x.kind) || now - x.at > SIGNAL_TTL_MS) continue;
    if (Object.hasOwn(s.favorites, x.id) || Object.hasOwn(s.excluded, x.id)) continue;
    last.set(x.id, Math.max(last.get(x.id) ?? -Infinity, x.at));
  }
  return [...last].sort((a, b) => b[1] - a[1]).slice(0, MAX_RECENT);
}

/**
 * 최근 열어 본 곳: 30일 안에 카카오맵을 열었거나 공유한 곳, 마지막으로 한 때가 최근인 것부터 한 번씩, 최대 20곳.
 * 즐겨찾기·뺀 곳은 그 묶음에 있으니 뺀다
 */
export const recentIds = (s: PersonalState, now: number): string[] => recentTimes(s, now).map(([id]) => id);

/**
 * 이름을 다시 불러올 곳: 세 묶음 중 지금 목록에도 3일 안 이름 기억에도 없는 곳, 한 시각(넣음·엶·뺌)이 최근인 것부터 최대 30곳
 */
export function unresolvedIds(s: PersonalState, now: number, live: (id: string) => LivePlace | undefined): string[] {
  const all: [string, number][] = [
    ...favoriteIds(s).map((id): [string, number] => [id, s.favorites[id]]),
    ...recentTimes(s, now),
    ...Object.entries(s.excluded),
  ];
  return all
    .filter(([id]) => live(id) === undefined && freshSnapshot(s, id, now) === undefined)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, MAX_RESOLVE);
}

/**
 * 세 묶음. 이름·설명은 지금 목록(live — 가장 새 정보) → 3일 안의 이름 기억 순으로 찾는다.
 * 둘 다 없으면 다시 불러오는 중(loading)이면 빈 이름(뼈대), 아니면 즐겨찾기·최근 곳은 "이전에 담은 가게", 뺀 곳은 "이전에 뺀 가게"
 */
export function mineSections(
  s: PersonalState, now: number, live: (id: string) => LivePlace | undefined, loading: (id: string) => boolean = () => false,
): MineSections {
  const item = (id: string, fallback: string): MineItem => {
    const l = live(id);
    if (l) {
      const pos = { lat: l.lat, lng: l.lng };
      return { id, name: l.name, line: placeLine(lastLevel(l.category) || undefined, pos), pos, loading: false };
    }
    const snap = freshSnapshot(s, id, now);
    if (snap) {
      const pos = { lat: snap.lat, lng: snap.lng };
      return { id, name: snap.name, line: placeLine(snap.cat, pos), pos, loading: false };
    }
    if (loading(id)) return { id, name: "", line: "", pos: null, loading: true };
    return { id, name: fallback, line: "", pos: null, loading: false };
  };
  return {
    favorites: favoriteIds(s).map((id) => item(id, FALLBACK_KEPT)),
    recent: recentIds(s, now).map((id) => item(id, FALLBACK_KEPT)),
    excluded: excludedIds(s).map((id) => item(id, FALLBACK_EXCLUDED)),
  };
}
