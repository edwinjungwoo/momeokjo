import { z } from "zod";
import { parseHours, type RawDay } from "../shared/hours";
import { representativePrice } from "../shared/price";
import type { Menu, PlaceDetail, PlaceSummary } from "../shared/types";

const ReviewSchema = z.object({
  score_set: z
    .object({
      review_count: z.number().nullish(),
      average_score: z.number().nullish(),
      strength_counts: z.array(z.object({ id: z.number(), count: z.number() })).nullish(),
    })
    .nullish(),
  strength_description: z.array(z.object({ id: z.number(), name: z.string() })).nullish(),
});

const MenuSchema = z.object({
  menus: z
    .object({ items: z.array(z.object({ name: z.string().nullish(), price: z.number().nullish() })).nullish() })
    .nullish(),
});

const DaySchema = z.object({
  day_of_the_week_desc: z.string().nullish(),
  on_days: z
    .object({ start_end_time_desc: z.string().nullish(), break_times_desc: z.array(z.string()).nullish() })
    .nullish(),
  off_days_desc: z.string().nullish(),
});

const HoursSchema = z.object({
  week_from_today: z
    .object({ week_periods: z.array(z.object({ days: z.array(DaySchema).nullish() })).nullish() })
    .nullish(),
});

const IconsSchema = z.array(z.object({ text: z.string().nullish() })).nullish();

const AddInfoSchema = z.object({
  store_facility_icons: IconsSchema,
  ai_mate: z.object({ store_facility_icons: IconsSchema }).nullish(),
  full_detail_infos: z
    .array(
      z.object({
        items: z.array(z.object({ contents: z.array(z.object({ label: z.string().nullish() })).nullish() })).nullish(),
      }),
    )
    .nullish(),
});

const SummarySchema = z.object({
  name: z.string().min(1),
  category: z
    .object({ name1: z.string().nullish(), name2: z.string().nullish(), name3: z.string().nullish() })
    .nullish(),
  point: z.object({ lat: z.number(), lon: z.number() }),
  address: z.object({ road: z.string().nullish(), disp: z.string().nullish() }).nullish(),
  phone_numbers: z.array(z.object({ tel: z.string().nullish() })).nullish(),
});

const KNOWN_KEYS = ["summary", "kakaomap_review", "menu", "open_hours", "place_add_info"];
const MAX_MENUS = 20;
const MAX_TAGS = 30;

export type DetailParseResult =
  | { ok: true; summary: PlaceSummary; detail: PlaceDetail }
  | { ok: false; reason: "schema" };

function section<S extends z.ZodType>(schema: S, value: unknown): z.output<S> | null {
  if (value === null || value === undefined) return null;
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}

export function parseDetail(raw: unknown): DetailParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "schema" };
  const r = raw as Record<string, unknown>;
  if (!KNOWN_KEYS.some((k) => k in r)) return { ok: false, reason: "schema" };
  const s = section(SummarySchema, r.summary);
  if (!s) return { ok: false, reason: "schema" };
  const summary: PlaceSummary = {
    name: s.name,
    categoryName: [s.category?.name1, s.category?.name2, s.category?.name3].filter((x): x is string => !!x).join(" > "),
    lat: s.point.lat,
    lng: s.point.lon,
    address: s.address?.road || s.address?.disp || null,
    phone: s.phone_numbers?.[0]?.tel || null,
  };

  const review = section(ReviewSchema, r.kakaomap_review);
  const reviewCount = review?.score_set?.review_count ?? null;
  const average = review?.score_set?.average_score ?? null;
  const rating = reviewCount !== null && reviewCount > 0 && average !== null ? average : null;
  const strengthNames = new Map((review?.strength_description ?? []).map((s) => [s.id, s.name]));
  const strengths = [...(review?.score_set?.strength_counts ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((s) => strengthNames.get(s.id))
    .filter((n): n is string => typeof n === "string");

  const menuSection = section(MenuSchema, r.menu);
  const allMenus: Menu[] = (menuSection?.menus?.items ?? [])
    .filter((i) => !!i.name && typeof i.price === "number" && i.price > 0)
    .map((i) => ({ name: i.name as string, price: i.price as number }));

  const hoursSection = section(HoursSchema, r.open_hours);
  const days: RawDay[] = (hoursSection?.week_from_today?.week_periods ?? [])
    .flatMap((p) => p.days ?? [])
    .map((d) => ({
      day_of_the_week_desc: d.day_of_the_week_desc ?? undefined,
      off_days_desc: d.off_days_desc ?? undefined,
      on_days: d.on_days
        ? {
            start_end_time_desc: d.on_days.start_end_time_desc ?? undefined,
            break_times_desc: d.on_days.break_times_desc ?? undefined,
          }
        : undefined,
    }));

  const add = section(AddInfoSchema, r.place_add_info);
  const bookable =
    add === null
      ? null
      : [...(add.store_facility_icons ?? []), ...(add.ai_mate?.store_facility_icons ?? [])].some(
          (i) => i.text === "예약가능",
        );
  const tags: string[] = [];
  for (const block of add?.full_detail_infos ?? []) {
    for (const item of block.items ?? []) {
      for (const c of item.contents ?? []) {
        if (c.label && !tags.includes(c.label) && tags.length < MAX_TAGS) tags.push(c.label);
      }
    }
  }

  return {
    ok: true,
    summary,
    detail: {
      rating,
      reviewCount,
      price: representativePrice(allMenus),
      menus: allMenus.slice(0, MAX_MENUS),
      hours: parseHours(days),
      strengths,
      bookable,
      tags,
    },
  };
}
