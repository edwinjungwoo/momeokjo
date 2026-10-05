import { DEFAULT_RADIUS } from "./constants";
import { isOpenDuring } from "./hours";
import type { ApiPlace, CategoryGroup } from "./types";

export type Party = 1 | 2 | 3 | 4;
export type PriceCap = "all" | 10000 | 15000 | 20000;
export type MinRating = 0 | 3.5 | 4;
export type SortKey = "distance" | "rating" | "price";

export type Filters = {
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
  radius: DEFAULT_RADIUS,
  party: 2,
  groups: [],
  includeBar: false,
  priceCap: "all",
  minRating: 0,
  openOnly: true,
  sort: "distance",
};


/** R19 판단은 서버가 shared/friendly 규칙으로 미리 계산해서 준다 */
export const isSoloFriendly = (p: ApiPlace) => p.detail?.soloFriendly ?? false;
export const isGroupFriendly = (p: ApiPlace) => p.detail?.groupFriendly ?? false;

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

/** R21′: 같은 그룹이 이미 뽑혔으면 다음 뽑기에서 이만큼 곱한다 (하나 뽑힐 때마다 한 번씩) */
export const SAME_GROUP_FACTOR = 0.35;
export const TRIO_SIZE = 3;

export type TrioResult = { places: ApiPlace[]; reset: boolean };
export type DrawOptions = {
  /** R37 개인화 배수. 0이면 후보에서 뺀다 ("여긴 빼줘") */
  multiplier?: (p: ApiPlace) => number;
};

/** 가중 비복원 추출. 이미 뽑힌 그룹은 SAME_GROUP_FACTOR로 낮춘다 (강제 아님) */
function sampleInto(
  out: ApiPlace[], pool: ApiPlace[], n: number, weight: (p: ApiPlace) => number, rng: () => number,
) {
  const left = [...pool];
  while (out.length < n && left.length > 0) {
    const ws = left.map((p) => weight(p) * SAME_GROUP_FACTOR ** out.filter((q) => q.group === p.group).length);
    const total = ws.reduce((a, b) => a + b, 0);
    let x = rng() * total;
    let i = 0;
    for (; i < left.length - 1; i++) {
      x -= ws[i];
      if (x < 0) break;
    }
    out.push(left[i]);
    left.splice(i, 1);
  }
}

/**
 * R21′: 서로 다른 후보 최대 3곳을 가중 랜덤으로 뽑는다 (0곳이면 null).
 * exclude(이번 세션에 이미 보여준 곳)는 빼고 뽑는다. 남은 곳이 3곳보다 적으면
 * 남은 곳을 먼저 넣고 제외를 풀어 나머지를 채운다(reset: true) — 한 결과 안에서는 중복이 없다.
 */
export function drawTrio(
  candidates: ApiPlace[], party: Party, exclude: ReadonlySet<string>, rng: () => number, opts: DrawOptions = {},
): TrioResult | null {
  const mult = opts.multiplier ?? (() => 1);
  const eligible = candidates.filter((p) => mult(p) > 0);
  if (eligible.length === 0) return null;
  const weight = (p: ApiPlace) => weightOf(p, party) * mult(p);
  const n = Math.min(TRIO_SIZE, eligible.length);
  const fresh = eligible.filter((p) => !exclude.has(p.id));
  const out: ApiPlace[] = [];
  if (fresh.length >= n) {
    sampleInto(out, fresh, n, weight, rng);
    return { places: out, reset: false };
  }
  sampleInto(out, fresh, fresh.length, weight, rng);
  sampleInto(out, eligible.filter((p) => !out.includes(p)), n, weight, rng);
  return { places: out, reset: true };
}
