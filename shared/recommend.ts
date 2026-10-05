import { LUNCH_RADIUS } from "./constants";
import { isOpenDuring } from "./hours";
import type { ApiPlace, CategoryGroup, LunchMinutes } from "./types";

export type Party = 1 | 2 | 3 | 4;
export type PriceCap = "all" | 10000 | 15000 | 20000;
export type MinRating = 0 | 3.5 | 4;
export type SortKey = "distance" | "rating" | "price";

export type Filters = {
  lunch: LunchMinutes | null;
  radius: number;
  party: Party;
  groups: CategoryGroup[];
  includeBar: boolean;
  priceCap: PriceCap;
  minRating: MinRating;
  openOnly: boolean;
  sort: SortKey;
};

export const DEFAULT_FILTERS: Filters = {
  lunch: 60,
  radius: LUNCH_RADIUS[60],
  party: 2,
  groups: [],
  includeBar: false,
  priceCap: "all",
  minRating: 0,
  openOnly: true,
  sort: "distance",
};

export const withLunch = (f: Filters, lunch: LunchMinutes): Filters => ({ ...f, lunch, radius: LUNCH_RADIUS[lunch] });
export const withRadius = (f: Filters, radius: number): Filters => ({ ...f, radius, lunch: null });

const SOLO_KEYWORDS = ["국밥", "해장국", "라멘", "라면", "분식", "덮밥", "돈까스", "우동", "국수", "김밥", "패스트푸드"];
const GROUP_TAGS = ["단체석", "회식장소", "모임맛집"];

export const isSoloFriendly = (p: ApiPlace) =>
  SOLO_KEYWORDS.some((k) => p.category.includes(k)) || (p.detail?.tags.includes("혼밥") ?? false);
export const isGroupFriendly = (p: ApiPlace) => p.detail?.tags.some((t) => GROUP_TAGS.includes(t)) ?? false;

export function filterPlaces(places: ApiPlace[], f: Filters, now: Date): ApiPlace[] {
  return places.filter((p) => {
    if (p.group === "dessert") return false;
    if ((p.distance ?? Infinity) > f.radius) return false;
    if (p.group === "bar") {
      if (!f.includeBar) return false;
    } else if (f.groups.length > 0 && !f.groups.includes(p.group)) return false;
    if (f.party >= 4 && p.group === "snack") return false;
    if (f.priceCap !== "all") {
      const price = p.detail?.price ?? null;
      if (price === null || price > f.priceCap) return false;
    }
    if (f.minRating > 0) {
      const rating = p.detail?.rating ?? null;
      if (rating === null || rating < f.minRating) return false;
    }
    if (f.openOnly && isOpenDuring(p.detail?.hours ?? null, now, 30) === false) return false;
    return true;
  });
}

export function sortPlaces(places: ApiPlace[], key: SortKey): ApiPlace[] {
  const dist = (p: ApiPlace) => p.distance ?? Infinity;
  const arr = [...places];
  if (key === "rating") {
    return arr.sort((a, b) => (b.detail?.rating ?? -1) - (a.detail?.rating ?? -1) || dist(a) - dist(b));
  }
  if (key === "price") {
    return arr.sort((a, b) => {
      const pa = a.detail?.price ?? Infinity;
      const pb = b.detail?.price ?? Infinity;
      return (pa === pb ? 0 : pa - pb) || dist(a) - dist(b);
    });
  }
  return arr.sort((a, b) => dist(a) - dist(b));
}

export function weightOf(p: ApiPlace, party: Party): number {
  const rating = p.detail?.rating ?? null;
  const reviews = p.detail?.reviewCount ?? 0;
  let w = rating === null ? 0.5 : Math.max(0.3, rating - 3) * Math.log10(reviews + 10);
  if (party === 1 && isSoloFriendly(p)) w *= 1.5;
  if (party >= 4) {
    if (isGroupFriendly(p)) w *= 1.3;
    if (p.detail?.bookable === true) w *= 1.3;
  }
  return w;
}

export type DrawResult = { place: ApiPlace; reset: boolean };

export function draw(
  candidates: ApiPlace[], party: Party, exclude: ReadonlySet<string>, rng: () => number,
): DrawResult | null {
  if (candidates.length === 0) return null;
  let pool = candidates.filter((p) => !exclude.has(p.id));
  let reset = false;
  if (pool.length === 0) {
    pool = candidates;
    reset = true;
  }
  const weights = pool.map((p) => weightOf(p, party));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    x -= weights[i];
    if (x < 0) return { place: pool[i], reset };
  }
  return { place: pool[pool.length - 1], reset };
}
