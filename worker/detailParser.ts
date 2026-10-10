import { kakaoPhotoUrl } from "../shared/photo";
import { parseHours, type RawDay } from "../shared/hours";
import { representativePrice } from "../shared/price";
import type { Menu, PlaceDetail, PlaceSummary } from "../shared/types";

/**
 * 상세 응답의 섹션 검사 (R6). 섹션마다 아래 모양이 아니면 그 섹션은 통째로 없는 것(null)으로 보고 — 요약(summary)이 그러면 schema 실패 —
 * 나머지 섹션은 살린다. 규칙은 예전 zod 스키마와 같다: 객체는 null이 아니고 배열이 아닌 object, 숫자는 유한한 number, 문자열은 string,
 * "없어도 됨"(nullish)은 null·undefined도 통과, 배열은 모든 원소가 맞아야 한다. 모르는 키는 보지 않는다.
 * Task 57: zod 스키마 검사는 새 isolate의 Cron에서 상세 한 곳마다 ~0.3ms(로컬 workerd 프로필 — 해석 CPU의 절반)라 손으로 검사한다.
 * 검사를 통과한 값은 원래 객체를 그대로 읽는다 (zod는 같은 값을 복사해 돌려줬다). 예전 zod 해석과 같은 값인지는
 * test/worker/detailParser.test.ts가 픽스처와 변형 3천여 개로 비교한다 (test/helpers/detailParserZod.ts)
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNil = (v: unknown): v is null | undefined => v === null || v === undefined;
const optStr = (v: unknown) => isNil(v) || typeof v === "string";
const optNum = (v: unknown) => isNil(v) || isNum(v);
/** 없거나(null·undefined), 모든 원소가 ok인 배열 */
const optArr = (v: unknown, ok: (x: unknown) => boolean) => isNil(v) || (Array.isArray(v) && v.every(ok));
/** 없거나, ok인 객체 */
const optObj = (v: unknown, ok: (o: Obj) => boolean) => isNil(v) || (isObj(v) && ok(v));

type N<T> = T | null | undefined;
type Review = {
  score_set?: N<{ review_count?: N<number>; average_score?: N<number>; strength_counts?: N<{ id: number; count: number }[]> }>;
  strength_description?: N<{ id: number; name: string }[]>;
};
const isReview = (v: unknown): v is Review =>
  isObj(v) &&
  optObj(v.score_set, (s) =>
    optNum(s.review_count) && optNum(s.average_score) &&
    optArr(s.strength_counts, (c) => isObj(c) && isNum(c.id) && isNum(c.count))) &&
  optArr(v.strength_description, (d) => isObj(d) && isNum(d.id) && typeof d.name === "string");

type MenuSection = { menus?: N<{ items?: N<{ name?: N<string>; price?: N<number> }[]> }> };
const isMenuSection = (v: unknown): v is MenuSection =>
  isObj(v) && optObj(v.menus, (m) => optArr(m.items, (i) => isObj(i) && optStr(i.name) && optNum(i.price)));

type Day = {
  day_of_the_week_desc?: N<string>;
  on_days?: N<{ start_end_time_desc?: N<string>; break_times_desc?: N<string[]> }>;
  off_days_desc?: N<string>;
};
const isDay = (d: unknown): d is Day =>
  isObj(d) &&
  optStr(d.day_of_the_week_desc) &&
  optObj(d.on_days, (o) => optStr(o.start_end_time_desc) && optArr(o.break_times_desc, (t) => typeof t === "string")) &&
  optStr(d.off_days_desc);
type HoursSection = { week_from_today?: N<{ week_periods?: N<{ days?: N<Day[]> }[]> }> };
const isHoursSection = (v: unknown): v is HoursSection =>
  isObj(v) && optObj(v.week_from_today, (w) => optArr(w.week_periods, (p) => isObj(p) && optArr(p.days, isDay)));

type Icons = N<{ text?: N<string> }[]>;
const isIcons = (v: unknown) => optArr(v, (i) => isObj(i) && optStr(i.text));
type AddInfo = {
  store_facility_icons?: Icons;
  ai_mate?: N<{ store_facility_icons?: Icons }>;
  full_detail_infos?: N<{ items?: N<{ contents?: N<{ label?: N<string> }[]> }[]> }[]>;
};
const isAddInfo = (v: unknown): v is AddInfo =>
  isObj(v) &&
  isIcons(v.store_facility_icons) &&
  optObj(v.ai_mate, (a) => isIcons(a.store_facility_icons)) &&
  optArr(v.full_detail_infos, (b) =>
    isObj(b) && optArr(b.items, (it) => isObj(it) && optArr(it.contents, (c) => isObj(c) && optStr(c.label))));

type Summary = {
  name: string;
  category?: N<{ name1?: N<string>; name2?: N<string>; name3?: N<string> }>;
  point: { lat: number; lon: number };
  address?: N<{ road?: N<string>; disp?: N<string> }>;
  phone_numbers?: N<{ tel?: N<string> }[]>;
  main_photo_url?: N<string>;
};
const isSummary = (v: unknown): v is Summary =>
  isObj(v) &&
  typeof v.name === "string" && v.name.length >= 1 &&
  optObj(v.category, (c) => optStr(c.name1) && optStr(c.name2) && optStr(c.name3)) &&
  isObj(v.point) && isNum(v.point.lat) && isNum(v.point.lon) &&
  optObj(v.address, (a) => optStr(a.road) && optStr(a.disp)) &&
  optArr(v.phone_numbers, (p) => isObj(p) && optStr(p.tel)) &&
  optStr(v.main_photo_url);

const KNOWN_KEYS = ["summary", "kakaomap_review", "menu", "open_hours", "place_add_info"];
const MAX_MENUS = 20;
const MAX_TAGS = 30;

export type DetailParseResult =
  | { ok: true; summary: PlaceSummary; detail: PlaceDetail }
  | { ok: false; reason: "schema" };

/** 섹션이 모양에 맞으면 그 값, 아니면(없음 포함) null */
const section = <T>(ok: (v: unknown) => v is T, value: unknown): T | null => (ok(value) ? value : null);

export function parseDetail(raw: unknown): DetailParseResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "schema" };
  const r = raw as Record<string, unknown>;
  if (!KNOWN_KEYS.some((k) => k in r)) return { ok: false, reason: "schema" };
  const s = section(isSummary, r.summary);
  if (!s) return { ok: false, reason: "schema" };
  const summary: PlaceSummary = {
    name: s.name,
    categoryName: [s.category?.name1, s.category?.name2, s.category?.name3].filter((x): x is string => !!x).join(" > "),
    lat: s.point.lat,
    lng: s.point.lon,
    address: s.address?.road || s.address?.disp || null,
    phone: s.phone_numbers?.[0]?.tel || null,
    photoUrl: kakaoPhotoUrl(s.main_photo_url),
  };

  const review = section(isReview, r.kakaomap_review);
  const reviewCount = review?.score_set?.review_count ?? null;
  const average = review?.score_set?.average_score ?? null;
  const rating = reviewCount !== null && reviewCount > 0 && average !== null ? average : null;
  const strengthNames = new Map((review?.strength_description ?? []).map((d) => [d.id, d.name]));
  const strengths = [...(review?.score_set?.strength_counts ?? [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((c) => strengthNames.get(c.id))
    .filter((n): n is string => typeof n === "string");

  const menuSection = section(isMenuSection, r.menu);
  const allMenus: Menu[] = (menuSection?.menus?.items ?? [])
    .filter((i) => !!i.name && typeof i.price === "number" && i.price > 0)
    .map((i) => ({ name: i.name as string, price: i.price as number }));

  const hoursSection = section(isHoursSection, r.open_hours);
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

  const add = section(isAddInfo, r.place_add_info);
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
