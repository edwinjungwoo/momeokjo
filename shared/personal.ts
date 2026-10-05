import { lastLevel } from "./category";
import type { CategoryGroup } from "./types";

/**
 * R37: 기기 안에서만 쓰는 자동 개인화 (서버로 보내지 않는다).
 * 최근에 카카오맵을 열었거나 공유했거나 보여준 곳은 잠깐 덜 나오게 하고,
 * 최근 30일에 카카오맵·공유를 한 그룹은 조금 더 나오게 한다. "여긴 빼줘"는 되돌릴 때까지 0.
 * R40: 최근 36시간에 카카오맵·공유를 한 세부 종류(cat)는 잠깐 덜 나오게 한다.
 */
export type SignalKind = "kakao_open" | "shared" | "received" | "shown";
/** cat: 카테고리 마지막 단계(R40). 예전 신호에는 없다 */
export type Signal = { id: string; group: CategoryGroup; kind: SignalKind; at: number; cat?: string };
export type PersonalState = { signals: Signal[]; excluded: Record<string, number> };

export const EMPTY_PERSONAL: PersonalState = { signals: [], excluded: {} };
export const MAX_SIGNALS = 300;

const HOUR = 3600_000;
const DAY = 24 * HOUR;
export const SIGNAL_TTL_MS = 30 * DAY;

export const STRENGTH: Record<SignalKind, number> = { kakao_open: 0.85, shared: 0.5, received: 0.5, shown: 0.25 };
export const DECAY_MS: Record<SignalKind, number> = { kakao_open: 3 * DAY, shared: 3 * DAY, received: 3 * DAY, shown: DAY };
export const RECENCY_FLOOR = 0.05;
const BOOST_STEP = 0.15;
const BOOST_MAX = 1.45;
const PREFERENCE_KINDS: ReadonlySet<SignalKind> = new Set(["kakao_open", "shared"]);
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

/** category(카카오 카테고리 전체 문자열)가 없으면 피로도는 보지 않는다 */
export function personalMultiplier(
  s: PersonalState, p: { id: string; group: CategoryGroup; category?: string }, now: number,
): number {
  if (Object.hasOwn(s.excluded, p.id)) return 0;
  const fatigue = p.category === undefined ? 1 : categoryFatigue(s, lastLevel(p.category), now);
  return recencyFactor(s, p.id, now) * groupBoost(s, p.group, now) * fatigue;
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

export function excludePlace(s: PersonalState, id: string, now: number): PersonalState {
  return { ...s, excluded: { ...s.excluded, [id]: now } };
}

export function includePlace(s: PersonalState, id: string): PersonalState {
  const { [id]: _, ...rest } = s.excluded;
  return { ...s, excluded: rest };
}

const PLACE_ID = /^\d{1,15}$/;
const KINDS: ReadonlySet<string> = new Set(Object.keys(STRENGTH));
const GROUPS: ReadonlySet<string> = new Set<CategoryGroup>([
  "korean", "chinese", "japanese", "western", "asian", "snack", "bar", "dessert", "etc",
]);

const isCat = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= MAX_CAT_LENGTH;

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
  const excluded: Record<string, number> = {};
  if (typeof o.excluded === "object" && o.excluded !== null && !Array.isArray(o.excluded)) {
    for (const [id, at] of Object.entries(o.excluded)) {
      if (PLACE_ID.test(id) && typeof at === "number" && Number.isFinite(at)) excluded[id] = at;
    }
  }
  return { signals, excluded };
}
