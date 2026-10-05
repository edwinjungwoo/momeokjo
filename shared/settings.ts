import { z } from "zod";
import { isValidRadius } from "./constants";
import { DEFAULT_HUB_ID, isHubId } from "./hubs";
import { DEFAULT_FILTERS, type Filters } from "./recommend";
import { parseHubPath, parseShareParams, type ShareParams } from "./share";

/** R25: 필터와 선택한 거점 id */
export type Settings = { filters: Filters; hubId: string };
export const DEFAULT_SETTINGS: Settings = { filters: DEFAULT_FILTERS, hubId: DEFAULT_HUB_ID };

const D = DEFAULT_FILTERS as any;
const FiltersSchema = z.object({
  radius: z.number().refine(isValidRadius).catch(D.radius),
  party: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).catch(D.party),
  groups: z.array(z.enum(["korean", "chinese", "japanese", "western", "asian", "snack", "etc"])).catch(D.groups),
  includeBar: z.boolean().catch(D.includeBar),
  priceCap: z.union([z.literal("all"), z.literal(10000), z.literal(15000), z.literal(20000)]).catch(D.priceCap),
  minRating: z.union([z.literal(0), z.literal(3.5), z.literal(4)]).catch(D.minRating),
  openOnly: z.boolean().catch(D.openOnly),
  sort: z.enum(["distance", "rating", "price"]).catch(D.sort),
});
const SettingsSchema = z.object({
  filters: FiltersSchema.catch(D),
  hubId: z.string().refine(isHubId).catch(DEFAULT_HUB_ID),
});

export function parseSettings(raw: string | null): Settings {
  if (!raw) return DEFAULT_SETTINGS;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
  const r = SettingsSchema.safeParse(json);
  return r.success ? (r.data as Settings) : DEFAULT_SETTINGS;
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
