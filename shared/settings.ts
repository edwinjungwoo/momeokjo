import { z } from "zod";
import { isValidRadius } from "./constants";
import { DEFAULT_HUB_ID, isHubId } from "./hubs";
import { DEFAULT_FILTERS, type Filters } from "./recommend";
import type { ShareParams } from "./share";

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
