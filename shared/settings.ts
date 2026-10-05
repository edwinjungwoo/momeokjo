import { isValidRadius } from "./constants";
import { DEFAULT_HUB_ID, isHubId } from "./hubs";
import { DEFAULT_FILTERS, type Filters } from "./recommend";
import { parseHubPath, parseShareParams, type ShareParams } from "./share";

/** R25: 필터와 선택한 거점 id */
export type Settings = { filters: Filters; hubId: string };
export const DEFAULT_SETTINGS: Settings = { filters: DEFAULT_FILTERS, hubId: DEFAULT_HUB_ID };

// R45: 화면 번들에서 zod(gzip 약 22KB)를 빼려고 손으로 검증한다. 규칙은 예전 스키마와 같다:
// 루트가 객체가 아니면 전체 기본값, filters가 객체가 아니면 필터 전체 기본값, 아니면 틀린 필드만 기본값 (모르는 키는 버린다)
const GROUPS = new Set(["korean", "chinese", "japanese", "western", "asian", "snack", "etc"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

function parseFilters(v: unknown): Filters {
  const D = DEFAULT_FILTERS;
  if (!isObject(v)) return { ...D, groups: [...D.groups] };
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
  if (!raw) return DEFAULT_SETTINGS;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!isObject(json)) return DEFAULT_SETTINGS;
  return {
    filters: parseFilters(json.filters),
    hubId: typeof json.hubId === "string" && isHubId(json.hubId) ? json.hubId : DEFAULT_HUB_ID,
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

export type Start = {
  settings: Settings;
  share: ShareParams;
  /** R43: 북마크 거점 경로로 열었으면 저장할 거점 id */
  saveHub: string | null;
  /** 주소창을 바꿀 값 (바꿀 필요가 없으면 null) */
  replaceUrl: string | null;
};

/**
 * R25/R43: 처음 열 때의 설정. 저장값 → 거점 경로(공유 링크가 아니면 저장) → 공유 파라미터(이번에만).
 * 공유 링크(t·p)의 거점 경로는 예전 h처럼 이번에만 쓰고, 주소는 /로 돌린다 (받은 사람의 저장 거점을 덮지 않게).
 */
export function resolveStart(stored: string | null, pathname: string, search: string): Start {
  const share = parseShareParams(search, pathname);
  const pathHub = parseHubPath(pathname);
  const isShare = share.placeIds.length > 0;
  const saveHub = pathHub !== null && !isShare ? pathHub : null;
  let settings = parseSettings(stored);
  if (saveHub) settings = { ...settings, hubId: saveHub };
  settings = applyShareParams(settings, share);
  const q = new URLSearchParams(search);
  const hasParams = SHARE_KEYS.some((k) => q.has(k));
  const replaceUrl = hasParams ? (isShare ? "/" : pathname) : null;
  return { settings, share, saveHub, replaceUrl };
}
