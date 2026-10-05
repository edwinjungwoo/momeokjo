import { z } from "zod";
import { ASEM, LUNCH_RADIUS, MAX_RADIUS, MIN_RADIUS } from "./constants";
import { DEFAULT_FILTERS, type Filters } from "./recommend";
import type { ShareParams } from "./share";
import type { LatLng, LunchMinutes } from "./types";

export type Settings = { filters: Filters; center: LatLng };
export const DEFAULT_SETTINGS: Settings = { filters: DEFAULT_FILTERS, center: ASEM };

const D = DEFAULT_FILTERS as any;
const FiltersSchema = z.object({
  lunch: z.union([z.literal(30), z.literal(60), z.literal(90), z.null()]).catch(D.lunch),
  radius: z.number().int().min(MIN_RADIUS).max(MAX_RADIUS).catch(D.radius),
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
  center: z.object({ lat: z.number().min(33).max(39), lng: z.number().min(124).max(132) }).catch(ASEM),
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
  if (share.center) next = { ...next, center: share.center };
  if (share.radius !== null) {
    const lunch = (Object.keys(LUNCH_RADIUS) as unknown as LunchMinutes[]).find(
      (k) => LUNCH_RADIUS[k] === share.radius,
    );
    next = { ...next, filters: { ...next.filters, radius: share.radius, lunch: lunch ? (Number(lunch) as LunchMinutes) : null } };
  }
  return next;
}
