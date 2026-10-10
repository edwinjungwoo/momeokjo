import { FILTER_GROUPS } from "./category";
import { isValidRadius } from "./constants";
import { DEFAULT_HUB_ID, isPublicHubId } from "./hubs";
import { DEFAULT_FILTERS, type Filters } from "./recommend";
import { isAdminPath, parseHubPath, parseShareParams, type ShareParams } from "./share";

/** R25: 필터와 선택한 거점 id */
export type Settings = { filters: Filters; hubId: string };
export const DEFAULT_SETTINGS: Settings = { filters: DEFAULT_FILTERS, hubId: DEFAULT_HUB_ID };

// R45: 화면 번들에서 zod(gzip 약 22KB)를 빼려고 손으로 검증한다. 규칙은 예전 스키마와 같다:
// 루트가 객체가 아니면 전체 기본값, filters가 객체가 아니면 필터 전체 기본값, 아니면 틀린 필드만 기본값 (모르는 키는 버린다)
const GROUPS = new Set<unknown>(FILTER_GROUPS);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** 기본값의 새 사본 — 받은 쪽이 고쳐도 DEFAULT_FILTERS·DEFAULT_SETTINGS가 바뀌지 않게 */
const defaultFilters = (): Filters => ({ ...DEFAULT_FILTERS, groups: [...DEFAULT_FILTERS.groups] });
const defaultSettings = (): Settings => ({ filters: defaultFilters(), hubId: DEFAULT_SETTINGS.hubId });

function parseFilters(v: unknown): Filters {
  const D = DEFAULT_FILTERS;
  if (!isObject(v)) return defaultFilters();
  const groups = Array.isArray(v.groups) && v.groups.every((g) => GROUPS.has(g)) ? (v.groups as Filters["groups"]) : D.groups;
  return {
    radius: typeof v.radius === "number" && isValidRadius(v.radius) ? v.radius : D.radius,
    party: oneOf(v.party, [1, 2, 3, 4] as const, D.party),
    groups: [...groups],
    includeBar: bool(v.includeBar, D.includeBar),
    priceCap: oneOf(v.priceCap, ["all", 10000, 15000, 20000] as const, D.priceCap),
    minRating: oneOf(v.minRating, [0, 3.5, 4] as const, D.minRating),
    openOnly: bool(v.openOnly, D.openOnly),
    sort: oneOf(v.sort, ["distance", "rating", "price"] as const, D.sort),
  };
}

export function parseSettings(raw: string | null): Settings {
  if (!raw) return defaultSettings();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return defaultSettings();
  }
  if (!isObject(json)) return defaultSettings();
  return {
    filters: parseFilters(json.filters),
    // R62: 준비 중 거점은 모르는 거점처럼 기본 거점
    hubId: typeof json.hubId === "string" && isPublicHubId(json.hubId) ? json.hubId : DEFAULT_HUB_ID,
  };
}

export function applyShareParams(s: Settings, share: ShareParams): Settings {
  let next = s;
  if (share.hubId) next = { ...next, hubId: share.hubId };
  if (share.radius !== null) next = { ...next, filters: { ...next.filters, radius: share.radius } };
  return next;
}

/** 주소에서 지우는 공유 파라미터 (예전 링크의 lat/lng 포함) */
const SHARE_KEYS = ["t", "p", "h", "r", "lat", "lng"];

/**
 * R61: 이 기기가 거점을 이미 골랐는가. 따로 표시를 두지 않고 "설정 저장값이 있다"로 판단한다 —
 * 거점을 고르면(첫 접속 질문·짧은 링크·거점 칩) 설정을 저장하고, 예전부터 쓰던 사람(필터나 거점을 바꿔 본 사람)도
 * 저장값이 있어서 그대로 고른 것으로 친다 (모양이 예전 것이거나 깨졌어도 — 저장한 적이 있다는 뜻이라서).
 * 설정은 안 바꿨어도 첫 방문 안내를 닫은(뽑기를 해 본) 기기(tipSeen)도 기존 사용자로 친다.
 */
export const hasHubChoice = (stored: string | null, tipSeen = false): boolean => stored !== null || tipSeen;

/**
 * R61: 링크가 거점을 정해 주는가 — 거점 짧은 링크(/pangyo), 거점 경로나 h가 있는 공유 링크, 예전 h.
 * 거점이 없는 공유 링크(경로 거점·h 없는 t, 예전 p)는 정하지 않는다 — 기본 거점을 저장하지 않고 받은 시트 뒤에 묻는다
 */
function linkSetsHub(share: ShareParams): boolean {
  return share.hubId !== null;
}

/**
 * R61: 첫 접속 때 "어느 역 근처에서 점심 드세요?"를 물을까. 모두 맞을 때만 묻는다:
 * 이 기기에 거점 선택이 없고(hasHubChoice), 링크(짧은 링크·공유 링크)로 열지 않았고, 관리 화면이 아님
 */
export function needsHubPicker(o: { stored: string | null; tipSeen?: boolean; path: string; query: string }): boolean {
  if (isAdminPath(o.path) || hasHubChoice(o.stored, o.tipSeen)) return false;
  return !linkSetsHub(parseShareParams(o.query, o.path));
}

/**
 * R61: 지금 질문을 보일까. 거점 없는 공유 링크로 열었으면 받은 곳을 다 불러오고(못 찾았어도) 받은 시트를 닫은 뒤에 묻는다 —
 * 친구가 보낸 곳을 먼저 보여주고, 질문이 그 위에 겹치지 않게
 */
export function showHubPicker(o: { askHub: boolean; shareLink: boolean; shareSettled: boolean; sheetOpen: boolean }): boolean {
  if (!o.askHub) return false;
  return !o.shareLink || (o.shareSettled && !o.sheetOpen);
}

export type Start = {
  settings: Settings;
  share: ShareParams;
  /** R43: 북마크 거점 경로로 열었으면 저장할 거점 id. R61: 거점 선택이 없는 기기에서 거점을 정한 공유 링크로 열었으면 그 거점 */
  saveHub: string | null;
  /** 주소창을 바꿀 값 (바꿀 필요가 없으면 null) — 언제나 같은 사이트의 경로 */
  replaceUrl: string | null;
  /** R61: 첫 접속이라 거점을 물어야 하는가 */
  askHub: boolean;
  /**
   * R25: 저장할 때의 기준 — 저장값 + 이번에 저장한 거점(saveHub). 공유 링크가 이번에만 바꾼 거점·반경은 사용자가 바꾸기 전까지
   * 이 값으로 저장한다 (settingsToSave)
   */
  base: Settings;
};

/**
 * R25/R43: 처음 열 때의 설정. 저장값 → 거점 경로(공유 링크가 아니면 저장) → 공유 파라미터(이번에만).
 * 공유 링크(t·p)의 거점 경로는 예전 h처럼 이번에만 쓰고, 주소는 /로 돌린다 (받은 사람의 저장 거점을 덮지 않게).
 * R61: 단, 거점 선택이 아직 없는 기기면 공유 링크가 정한 거점(경로·h)을 이 기기의 거점으로 저장한다 (덮을 저장 거점이 없고, 다시 묻지 않게).
 * 거점이 없는 공유 링크면 아무것도 저장하지 않고 askHub(받은 시트 뒤에 묻기). 반경 같은 다른 공유 파라미터는 그래도 이번에만이다.
 */
export function resolveStart(stored: string | null, pathname: string, search: string, tipSeen = false): Start {
  const share = parseShareParams(search, pathname);
  const pathHub = parseHubPath(pathname);
  const isShare = share.placeIds.length > 0;
  let saveHub = pathHub !== null && !isShare ? pathHub : null;
  let settings = parseSettings(stored);
  if (saveHub) settings = { ...settings, hubId: saveHub };
  settings = applyShareParams(settings, share);
  const chosen = hasHubChoice(stored, tipSeen);
  if (saveHub === null && !chosen && linkSetsHub(share)) saveHub = settings.hubId;
  const q = new URLSearchParams(search);
  const hasParams = SHARE_KEYS.some((k) => q.has(k));
  // //x·/\x는 다른 호스트(https://x/)로 풀려 replaceState가 던진다 — 같은 사이트의 경로만 남긴다
  const samePath = /^\/(?![/\\])/.test(pathname) ? pathname : "/";
  const replaceUrl = hasParams ? (isShare ? "/" : samePath) : null;
  const askHub = needsHubPicker({ stored, tipSeen, path: pathname, query: search });
  const parsed = parseSettings(stored);
  const base = saveHub ? { ...parsed, hubId: saveHub } : parsed;
  return { settings, share, saveHub, replaceUrl, askHub, base };
}

/** R25: 이번 세션에 사용자가 직접 바꾼 거점·반경 (공유 링크가 이번에만 정한 값과 구분한다) */
export type Ownership = { hubId: boolean; radius: boolean };

/** 설정이 prev → next로 바뀔 때 사용자가 바꾼 것을 표시한다 (한 번 바꾼 것은 계속 사용자 것) */
export function noteOwnership(own: Ownership, prev: Settings, next: Settings): Ownership {
  const hubId = own.hubId || next.hubId !== prev.hubId;
  const radius = own.radius || next.filters.radius !== prev.filters.radius;
  return hubId === own.hubId && radius === own.radius ? own : { hubId, radius };
}

/**
 * R25/R43: 저장할 설정 — 공유 링크의 거점·반경은 이번에만이라 사용자가 직접 바꾸지 않았으면 저장값(base) 그대로 두고,
 * 나머지는 지금 설정. 받은 사람이 인원·정렬만 바꿔도 친구가 보낸 거점·반경이 저장되던 것 (Task 56)
 */
export function settingsToSave(base: Settings, next: Settings, own: Ownership): Settings {
  return {
    filters: { ...next.filters, radius: own.radius ? next.filters.radius : base.filters.radius },
    hubId: own.hubId ? next.hubId : base.hubId,
  };
}

/**
 * R43: 손으로 거점을 바꿨을 때 주소창에 둘 값. 지금 주소가 거점 경로(/{거점 id})면 "/"(쿼리 없이) —
 * 그대로 두면 새로고침할 때 북마크 거점으로 되돌아가서 방금 고른 거점(저장값)을 덮는다. 아니면 null(그대로).
 */
export const urlAfterHubChange = (pathname: string): string | null => (parseHubPath(pathname) !== null ? "/" : null);
