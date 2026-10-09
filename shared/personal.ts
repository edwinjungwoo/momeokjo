import { lastLevel } from "./category";
import { PLACES_CACHE_MAX_AGE_MS } from "./placesCache";
import type { CategoryGroup } from "./types";

/**
 * R37: 기기 안에서만 쓰는 자동 개인화 (서버로 보내지 않는다).
 * 최근에 카카오맵을 열었거나 공유했거나 보여준 곳은 잠깐 덜 나오게 하고,
 * 최근 30일에 카카오맵·공유를 한 그룹은 조금 더 나오게 한다. "다음부터 안 보기"는 되돌릴 때까지 0.
 * R40: 최근 36시간에 카카오맵·공유를 한 세부 종류(cat)는 잠깐 덜 나오게 한다.
 */
export type SignalKind = "kakao_open" | "shared" | "received" | "shown";
/** cat: 카테고리 마지막 단계(R40). 예전 신호에는 없다 */
export type Signal = { id: string; group: CategoryGroup; kind: SignalKind; at: number; cat?: string };
/**
 * R65: "내 가게"가 이름을 보여주려고 잠깐 기억하는 것. at = 마지막으로 남긴(새로 한) 시각.
 * 즐겨찾기·카카오맵 열기·공유·"다음부터 안 보기" 때와 그 곳이 목록·단건 응답에 나올 때 남기고,
 * 3일(SNAPSHOT_MAX_AGE_MS — 기기 목록 저장본과 같은 기준, 스펙 §3.1)이 지나거나 어디에서도 가리키지 않으면 버린다 (pruneSnapshots).
 * 즐겨찾기·뺀 곳·최근 신호 자체는 id와 시각만 오래 남는다 — 이름은 3일이 지나면 다시 불러온다
 */
export type Snapshot = { name: string; group: CategoryGroup; cat?: string; lat: number; lng: number; at: number };
/**
 * excluded·favorites: id → 그렇게 한 시각. R65 favorites·snapshots는 나중에 더해서 예전 저장값에는 없다 (parsePersonal이 빈 값으로 채운다)
 */
export type PersonalState = {
  signals: Signal[];
  excluded: Record<string, number>;
  favorites: Record<string, number>;
  snapshots: Record<string, Snapshot>;
};

export const EMPTY_PERSONAL: PersonalState = { signals: [], excluded: {}, favorites: {}, snapshots: {} };
export const MAX_SIGNALS = 300;
/** R65: 즐겨찾기 최대 수 (넘치면 가장 오래 전에 넣은 곳부터 뺀다) */
export const MAX_FAVORITES = 100;
/** R65: 이름 기억 최대 수 (넘치면 즐겨찾기는 지키고 오래된 것부터 버린다) */
export const MAX_SNAPSHOTS = 200;
export const MAX_NAME_LENGTH = 80;
/** R65: 이름 기억을 쓰고 남기는 최대 기간 — 기기 목록 저장본(R45)과 같은 3일 */
export const SNAPSHOT_MAX_AGE_MS = PLACES_CACHE_MAX_AGE_MS;
/** R65: 목록이 다시 와도 이 시간 안에 새로 한 이름은 그대로 둔다 (폴링마다 저장하지 않게) */
export const SNAPSHOT_REFRESH_MS = 3600_000;
/** R65: 즐겨찾기는 조금 더 나온다 (최근 신호·그룹 가산·피로도와 곱한다 — 방금 간 즐겨찾기도 며칠은 쉰다) */
export const FAVORITE_BOOST = 1.3;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const SIGNAL_TTL_MS = 30 * DAY;

export const STRENGTH: Record<SignalKind, number> = { kakao_open: 0.85, shared: 0.5, received: 0.5, shown: 0.25 };
export const DECAY_MS: Record<SignalKind, number> = { kakao_open: 3 * DAY, shared: 3 * DAY, received: 3 * DAY, shown: DAY };
export const RECENCY_FLOOR = 0.05;
const BOOST_STEP = 0.15;
const BOOST_MAX = 1.45;
export const PREFERENCE_KINDS: ReadonlySet<SignalKind> = new Set(["kakao_open", "shared"]);
export const FATIGUE_WINDOW_MS = 36 * HOUR;
export const FATIGUE_STEP = 0.6;
export const FATIGUE_FLOOR = 0.4;
const MAX_CAT_LENGTH = 30;

/** 1(방금) → 0(창이 지남)으로 직선. 미래 시각(시계 어긋남)은 방금으로 본다 */
export function decay(kind: SignalKind, ageMs: number): number {
  return Math.max(0, 1 - Math.max(0, ageMs) / DECAY_MS[kind]);
}

/** 그 가게에 대한 최근 신호로 낮추는 배수. 바닥 0.05 */
export function recencyFactor(s: PersonalState, id: string, now: number): number {
  let f = 1;
  for (const x of s.signals) if (x.id === id) f *= 1 - STRENGTH[x.kind] * decay(x.kind, now - x.at);
  return Math.max(RECENCY_FLOOR, f);
}

/**
 * 최근 30일에 카카오맵을 열었거나 공유한 그룹은 1번마다 +0.15, 최대 ×1.45.
 * 공유 1번이 3곳을 한꺼번에 기록해도 같은 시각이므로 그룹당 1번으로 센다.
 */
export function groupBoost(s: PersonalState, group: CategoryGroup, now: number): number {
  const events = new Set<number>();
  for (const x of s.signals) {
    if (x.group === group && PREFERENCE_KINDS.has(x.kind) && now - x.at <= SIGNAL_TTL_MS) events.add(x.at);
  }
  return Math.min(BOOST_MAX, 1 + BOOST_STEP * events.size);
}

/**
 * R40: 최근 36시간에 카카오맵을 열었거나 공유한 세부 종류는 1번마다 ×0.6, 바닥 0.4.
 * 공유 1번이 같은 종류 여러 곳을 기록해도 같은 시각이므로 1번으로 센다. 빈 종류·cat 없는 신호는 세지 않는다.
 */
export function categoryFatigue(s: PersonalState, cat: string, now: number): number {
  if (!cat) return 1;
  const events = new Set<number>();
  for (const x of s.signals) {
    if (x.cat === cat && PREFERENCE_KINDS.has(x.kind) && now - x.at <= FATIGUE_WINDOW_MS) events.add(x.at);
  }
  return Math.max(FATIGUE_FLOOR, FATIGUE_STEP ** events.size);
}

/** category(카카오 카테고리 전체 문자열)가 없으면 피로도는 보지 않는다. R65: 즐겨찾기 ×1.3, 뺀 곳은 즐겨찾기여도 0 */
export function personalMultiplier(
  s: PersonalState, p: { id: string; group: CategoryGroup; category?: string }, now: number,
): number {
  if (Object.hasOwn(s.excluded, p.id)) return 0;
  const fatigue = p.category === undefined ? 1 : categoryFatigue(s, lastLevel(p.category), now);
  const favorite = isFavorite(s, p.id) ? FAVORITE_BOOST : 1;
  return recencyFactor(s, p.id, now) * groupBoost(s, p.group, now) * fatigue * favorite;
}

/** 신호가 아직 효과가 있는 동안만 남긴다: 취향 신호는 30일, 나머지는 감쇠 창이 끝날 때까지 */
function isLive(x: Signal, now: number): boolean {
  return now - x.at <= (PREFERENCE_KINDS.has(x.kind) ? SIGNAL_TTL_MS : DECAY_MS[x.kind]);
}

/** 효과가 끝난 신호는 버리고, 최대 MAX_SIGNALS개만 남긴다 (넘치면 취향 신호를 먼저 남기고 오래된 약한 신호부터 버린다) */
export function addSignals(s: PersonalState, add: Signal[], now: number): PersonalState {
  const live = [...s.signals, ...add].filter((x) => isLive(x, now)).sort((a, b) => a.at - b.at);
  if (live.length <= MAX_SIGNALS) return { ...s, signals: live };
  const prefs = live.filter((x) => PREFERENCE_KINDS.has(x.kind)).slice(-MAX_SIGNALS);
  const weak = live.filter((x) => !PREFERENCE_KINDS.has(x.kind)).slice(-(MAX_SIGNALS - prefs.length));
  return { ...s, signals: [...prefs, ...weak].sort((a, b) => a.at - b.at) };
}

/** R65: 즐겨찾기였으면 즐겨찾기에서도 뺀다 (두 목록에 함께 있지 않게). 되돌리기는 undoExclude */
export function excludePlace(s: PersonalState, id: string, now: number): PersonalState {
  const { [id]: _, ...favorites } = s.favorites;
  return { ...s, excluded: { ...s.excluded, [id]: now }, favorites };
}

/** R37/R65: 8초 "되돌리기" — 빼기를 풀고, 빼기 전에 즐겨찾기였으면(favoriteAt) 그 시각 그대로 돌려 놓는다 */
export function undoExclude(s: PersonalState, id: string, favoriteAt: number | undefined): PersonalState {
  const next = includePlace(s, id);
  return favoriteAt === undefined ? next : { ...next, favorites: { ...next.favorites, [id]: favoriteAt } };
}

export function includePlace(s: PersonalState, id: string): PersonalState {
  const { [id]: _, ...rest } = s.excluded;
  return { ...s, excluded: rest };
}

export const isFavorite = (s: PersonalState, id: string): boolean => Object.hasOwn(s.favorites, id);

/** 시각이 늦은 n개만 남긴다 */
function newest(m: Record<string, number>, n: number): Record<string, number> {
  const entries = Object.entries(m);
  if (entries.length <= n) return m;
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, n));
}

/** R65: 즐겨찾기에 넣는다. 빼 둔 곳이면 "다음부터 안 보기"를 푼다. 100곳을 넘으면 가장 오래 전에 넣은 곳부터 뺀다 */
export function addFavorite(s: PersonalState, id: string, now: number): PersonalState {
  return { ...includePlace(s, id), favorites: newest({ ...s.favorites, [id]: now }, MAX_FAVORITES) };
}

export function removeFavorite(s: PersonalState, id: string): PersonalState {
  const { [id]: _, ...rest } = s.favorites;
  return { ...s, favorites: rest };
}

/** 이름을 기억할 가게 (ApiPlace의 일부) */
export type SnapshotSource = { id: string; name: string; group: CategoryGroup; category?: string; lat: number; lng: number };

/**
 * 그 정보를 받은 때: stamp(id)가 있으면 그 값(기기 저장본이면 저장 시각), 없으면 지금. 미래(시계 어긋남)는 지금으로 자른다
 */
export type Stamp = (id: string) => number;
const sourceAt = (stamp: Stamp | undefined, id: string, now: number) => Math.min(stamp?.(id) ?? now, now);

function snapshotOf(p: SnapshotSource, at: number): Snapshot {
  const cat = p.category === undefined ? "" : lastLevel(p.category);
  return { name: p.name.trim().slice(0, MAX_NAME_LENGTH), group: p.group, ...(isCat(cat) ? { cat } : {}), lat: p.lat, lng: p.lng, at };
}

/**
 * R65: 이름·그룹·세부 종류·좌표를 기억한다. 시각은 그 정보를 받은 때(stamp — 기기 저장본에서 온 것이면 저장 시각)라서
 * 오래된 정보를 새것처럼 3일을 다시 늘리지 않는다. 이미 더 새 정보가 있으면 그대로, 3일 넘은 정보·틀린 값은 남기지 않는다
 */
export function saveSnapshots(s: PersonalState, places: SnapshotSource[], now: number, stamp?: Stamp): PersonalState {
  const snapshots = { ...s.snapshots };
  for (const p of places) {
    const at = sourceAt(stamp, p.id, now);
    const old = Object.hasOwn(snapshots, p.id) ? snapshots[p.id] : undefined;
    if (now - at > SNAPSHOT_MAX_AGE_MS || (old && old.at > at)) continue;
    const snap = snapshotOf(p, at);
    if (PLACE_ID.test(p.id) && isSnapshot(snap)) snapshots[p.id] = snap;
  }
  return { ...s, snapshots };
}

/** 즐겨찾기·뺀 곳·최근 30일 카카오맵/공유(= "최근 열어 본 곳" 후보) — 이름을 기억해 둘 곳 */
function referenced(s: PersonalState, now: number): Set<string> {
  const ids = new Set([...Object.keys(s.favorites), ...Object.keys(s.excluded)]);
  for (const x of s.signals) if (PREFERENCE_KINDS.has(x.kind) && now - x.at <= SIGNAL_TTL_MS) ids.add(x.id);
  return ids;
}

const isFresh = (x: Snapshot, now: number) => now - x.at <= SNAPSHOT_MAX_AGE_MS;

/** R65: 쓸 수 있는(3일 안) 이름 기억. 정리 전이어도 지난 것은 쓰지 않는다 */
export function freshSnapshot(s: PersonalState, id: string, now: number): Snapshot | undefined {
  const x = Object.hasOwn(s.snapshots, id) ? s.snapshots[id] : undefined;
  return x && isFresh(x, now) ? x : undefined;
}

/**
 * R65: 목록·단건 응답에 나온 곳 중 내 가게가 가리키는 곳의 이름 기억을 새로 한다 (요청을 더 하지 않고 자주 보는 곳은 늘 3일 안).
 * 1시간 안에 같은 값으로 새로 했으면 그대로 — 바뀐 것이 없으면 같은 상태 객체를 돌려준다 (저장·다시 그리기 없음)
 */
export function refreshSnapshots(s: PersonalState, places: SnapshotSource[], now: number, stamp?: Stamp): PersonalState {
  const ids = referenced(s, now);
  const due = places.filter((p) => {
    if (!ids.has(p.id)) return false;
    const at = sourceAt(stamp, p.id, now);
    if (now - at > SNAPSHOT_MAX_AGE_MS) return false;
    const old = Object.hasOwn(s.snapshots, p.id) ? s.snapshots[p.id] : undefined;
    if (!old) return true;
    if (old.at >= at) return false;
    if (at - old.at > SNAPSHOT_REFRESH_MS) return true;
    const next = snapshotOf(p, at);
    return old.name !== next.name || old.group !== next.group || old.cat !== next.cat || old.lat !== next.lat || old.lng !== next.lng;
  });
  return due.length === 0 ? s : saveSnapshots(s, due, now, stamp);
}

/**
 * R65: 읽을 때 정리 — 효과가 끝난 신호, 3일 지났거나 아무도 가리키지 않는 이름 기억을 버린다.
 * changed면 정리한 값을 한 번 다시 저장한다 (지난 이름이 기기에 남아 있지 않게)
 */
export function tidyPersonal(s: PersonalState, now: number): { state: PersonalState; changed: boolean } {
  const state = pruneSnapshots(addSignals(s, [], now), now);
  const changed =
    state.signals.length !== s.signals.length || Object.keys(state.snapshots).length !== Object.keys(s.snapshots).length;
  return { state, changed };
}

/**
 * R65: 내 가게가 가리키는 3일 안의 이름만 남기고(즐겨찾기·뺀 곳·최근 신호 자체는 그대로),
 * 200곳을 넘으면 즐겨찾기는 지키고 나머지는 오래된 것부터 버린다
 */
export function pruneSnapshots(s: PersonalState, now: number): PersonalState {
  const live = referenced(s, now);
  const kept = Object.entries(s.snapshots).filter(([id, x]) => live.has(id) && isFresh(x, now));
  if (kept.length === Object.keys(s.snapshots).length && kept.length <= MAX_SNAPSHOTS) return s;
  const rank = (id: string) => (isFavorite(s, id) ? 1 : 0);
  kept.sort((a, b) => rank(b[0]) - rank(a[0]) || b[1].at - a[1].at);
  return { ...s, snapshots: Object.fromEntries(kept.slice(0, MAX_SNAPSHOTS)) };
}

const PLACE_ID = /^\d{1,15}$/;
const KINDS: ReadonlySet<string> = new Set(Object.keys(STRENGTH));
const GROUPS: ReadonlySet<string> = new Set<CategoryGroup>([
  "korean", "chinese", "japanese", "western", "asian", "snack", "bar", "dessert", "etc",
]);

const isCat = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= MAX_CAT_LENGTH;
const isTime = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** R65: cat은 따로 검사한다 (틀리면 cat만 버린다) */
function isSnapshot(x: unknown): x is Snapshot {
  if (!isRecord(x)) return false;
  return (
    typeof x.name === "string" && x.name.length > 0 && x.name.length <= MAX_NAME_LENGTH &&
    typeof x.group === "string" && GROUPS.has(x.group) &&
    isTime(x.lat) && Math.abs(x.lat) <= 90 &&
    isTime(x.lng) && Math.abs(x.lng) <= 180 &&
    isTime(x.at)
  );
}

/** id → 시각 모음 (뺀 곳·즐겨찾기). 틀린 항목만 버린다 */
function parseTimes(x: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(x)) return out;
  for (const [id, at] of Object.entries(x)) if (PLACE_ID.test(id) && isTime(at)) out[id] = at;
  return out;
}

/** cat은 따로 검사한다 (틀려도 신호는 살리고 cat만 버린다) */
function isSignal(x: unknown): x is Signal {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" && PLACE_ID.test(o.id) &&
    typeof o.group === "string" && GROUPS.has(o.group) &&
    typeof o.kind === "string" && KINDS.has(o.kind) &&
    typeof o.at === "number" && Number.isFinite(o.at)
  );
}

/** localStorage 값 → 상태. 깨진 값은 버리고 올바른 항목만 남긴다 */
export function parsePersonal(raw: string | null): PersonalState {
  if (!raw) return EMPTY_PERSONAL;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return EMPTY_PERSONAL;
  }
  if (typeof json !== "object" || json === null) return EMPTY_PERSONAL;
  const o = json as Record<string, unknown>;
  const signals = Array.isArray(o.signals)
    ? o.signals.filter(isSignal).map(({ id, group, kind, at, cat }): Signal => ({
        id, group, kind, at, ...(isCat(cat) ? { cat } : {}),
      }))
    : [];
  const snapshots: Record<string, Snapshot> = {};
  if (isRecord(o.snapshots)) {
    for (const [id, x] of Object.entries(o.snapshots)) {
      if (!PLACE_ID.test(id) || !isSnapshot(x)) continue;
      const { name, group, cat, lat, lng, at } = x;
      snapshots[id] = { name, group, ...(isCat(cat) ? { cat } : {}), lat, lng, at };
    }
  }
  return {
    signals,
    excluded: parseTimes(o.excluded),
    favorites: newest(parseTimes(o.favorites), MAX_FAVORITES),
    snapshots,
  };
}
