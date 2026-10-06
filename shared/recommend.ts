import { DEFAULT_RADIUS, MAX_RADIUS } from "./constants";
import { isOpenDuring, kstParts } from "./hours";
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

/** R50: KST 분(0~1439). 11:55 ≤ t < 13:30은 가까운 곳, t < 11:20은 평점 높은 곳을 아주 조금 더 */
export const RUSH_START = 11 * 60 + 55;
export const RUSH_END = 13 * 60 + 30;
export const EARLY_END = 11 * 60 + 20;
const RUSH_BOOST = 0.25;
const EARLY_BOOST = 0.15;

/**
 * R50: 시간대 배수 (화면 문구 없음, 웨이팅을 안다고 하지 않는다).
 * 점심 한가운데: 1 + 0.25 × (1 − 도보 / maxWalk) — maxWalk = 이번 뽑기 후보 중 가장 먼 도보 분.
 * 이른 시간: 1 + 0.15 × clamp(평점 − 3.5, 0, 1.5) / 1.5. 그 밖의 시간, 도보·평점을 모르면 1.
 */
export function timeOfDayFactor(p: ApiPlace, now: Date, maxWalk: number): number {
  const { minute } = kstParts(now);
  if (minute >= RUSH_START && minute < RUSH_END) {
    if (p.walkMinutes === undefined || !(maxWalk > 0)) return 1;
    const closeness = Math.min(1, Math.max(0, 1 - p.walkMinutes / maxWalk));
    return 1 + RUSH_BOOST * closeness;
  }
  if (minute < EARLY_END) {
    const rating = p.detail?.rating ?? null;
    if (rating === null) return 1;
    return 1 + (EARLY_BOOST * Math.min(1.5, Math.max(0, rating - 3.5))) / 1.5;
  }
  return 1;
}

/** R21′: 같은 그룹이 이미 뽑혔으면 다음 뽑기에서 이만큼 곱한다 (하나 뽑힐 때마다 한 번씩) */
export const SAME_GROUP_FACTOR = 0.35;
export const TRIO_SIZE = 3;

export type TrioResult = { places: ApiPlace[]; reset: boolean };
export type DrawOptions = {
  /** R37 개인화 배수. 0이면 후보에서 뺀다 ("다음부터 안 보기") */
  multiplier?: (p: ApiPlace) => number;
  /** R41 완화로 들어온 곳. 원래 후보를 먼저 넣고 모자란 만큼만 여기서 채운다 */
  extra?: ApiPlace[];
  /** R50 시간대 배수를 매길 시각 (없으면 시간대를 보지 않는다) */
  now?: Date;
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
 * R41: opts.extra(완화로 들어온 곳)가 있으면 각 단계에서 원래 후보를 먼저, 모자란 만큼 extra에서 채운다.
 * R50: opts.now가 있으면 가중치에 시간대 배수(timeOfDayFactor)를 곱한다.
 */
export function drawTrio(
  candidates: ApiPlace[], party: Party, exclude: ReadonlySet<string>, rng: () => number, opts: DrawOptions = {},
): TrioResult | null {
  const mult = opts.multiplier ?? (() => 1);
  const base = candidates.filter((p) => mult(p) > 0);
  const extra = (opts.extra ?? []).filter((p) => mult(p) > 0 && !base.includes(p));
  const tiers = extra.length > 0 ? [base, extra] : [base];
  const total = base.length + extra.length;
  if (total === 0) return null;
  const now = opts.now;
  const maxWalk = now ? Math.max(0, ...[...base, ...extra].map((p) => p.walkMinutes ?? 0)) : 0;
  const weight = now
    ? (p: ApiPlace) => weightOf(p, party) * mult(p) * timeOfDayFactor(p, now, maxWalk)
    : (p: ApiPlace) => weightOf(p, party) * mult(p);
  const n = Math.min(TRIO_SIZE, total);
  const out: ApiPlace[] = [];
  for (const tier of tiers) sampleInto(out, tier.filter((p) => !exclude.has(p.id)), n, weight, rng);
  if (out.length >= n) return { places: out, reset: false };
  for (const tier of tiers) sampleInto(out, tier.filter((p) => !out.includes(p)), n, weight, rng);
  return { places: out, reset: true };
}

/** R41 완화 순서: 최소 평점 → 예산 → 카테고리 → 반경 +300m. 영업 중·인원·술집·디저트 제외는 풀지 않는다 */
export type RelaxStep = "minRating" | "priceCap" | "groups" | "radius";
export const RELAX_ORDER: RelaxStep[] = ["minRating", "priceCap", "groups", "radius"];
export const RELAX_RADIUS_STEP = 300;

/** 켜져 있는 조건만 푼다 (꺼져 있으면 null) */
function relaxOnce(f: Filters, step: RelaxStep): Filters | null {
  switch (step) {
    case "minRating":
      return f.minRating > 0 ? { ...f, minRating: 0 } : null;
    case "priceCap":
      return f.priceCap !== "all" ? { ...f, priceCap: "all" } : null;
    case "groups":
      return f.groups.length > 0 ? { ...f, groups: [] } : null;
    case "radius":
      return f.radius < MAX_RADIUS ? { ...f, radius: Math.min(MAX_RADIUS, f.radius + RELAX_RADIUS_STEP) } : null;
  }
}

/** p가 원래 조건 f의 그 단계를 어기는가 (완화로 들어온 곳이 실제로 어긴 조건만 알리려고) */
function violates(p: ApiPlace, f: Filters, step: RelaxStep): boolean {
  switch (step) {
    case "minRating": {
      const rating = p.detail?.rating ?? null;
      return f.minRating > 0 && (rating === null || rating < f.minRating);
    }
    case "priceCap": {
      const price = p.detail?.price ?? null;
      return f.priceCap !== "all" && (price === null || price > f.priceCap);
    }
    case "groups":
      return f.groups.length > 0 && p.group !== "bar" && !f.groups.includes(p.group);
    case "radius":
      return (p.distance ?? Infinity) > f.radius;
  }
}

export type Relaxed = {
  /** 원래 조건을 통과한 곳 (keep 적용) */
  candidates: ApiPlace[];
  /** 완화로 새로 들어온 곳 */
  extra: ApiPlace[];
  /** extra가 실제로 어긴 조건 (RELAX_ORDER 순) */
  relaxed: RelaxStep[];
  /** 반경을 넓혔으면 넓힌 m (아니면 0) */
  addedRadius: number;
};

/** R41: 주어진 곳들(완화 후보, 또는 결과에 실제로 뽑힌 완화 후보)이 원래 조건 f에서 어긴 단계 (RELAX_ORDER 순) */
export const relaxedBy = (places: ApiPlace[], f: Filters): RelaxStep[] =>
  RELAX_ORDER.filter((step) => places.some((p) => violates(p, f, step)));

/**
 * R41: 후보가 min(기본 3)곳보다 적으면 RELAX_ORDER대로 켜진 조건을 하나씩 풀어 min곳이 될 때까지 채운다.
 * keep: 원래 후보·완화 후보 모두에 거는 조건 (R37 빼둔 곳 제외).
 */
export function relaxToFill(
  places: ApiPlace[], f: Filters, now: Date, opts: { min?: number; keep?: (p: ApiPlace) => boolean } = {},
): Relaxed {
  const min = opts.min ?? TRIO_SIZE;
  const keep = opts.keep ?? (() => true);
  const pass = (g: Filters) => filterPlaces(places, g, now).filter(keep);
  const candidates = pass(f);
  if (candidates.length >= min) return { candidates, extra: [], relaxed: [], addedRadius: 0 };
  let g = f;
  let pool = candidates;
  for (const step of RELAX_ORDER) {
    if (pool.length >= min) break;
    const next = relaxOnce(g, step);
    if (!next) continue;
    g = next;
    pool = pass(g);
  }
  const inBase = new Set(candidates.map((p) => p.id));
  const extra = pool.filter((p) => !inBase.has(p.id));
  const relaxed = relaxedBy(extra, f);
  return { candidates, extra, relaxed, addedRadius: relaxed.includes("radius") ? g.radius - f.radius : 0 };
}

const RELAX_LABEL: Record<Exclude<RelaxStep, "radius">, string> = { minRating: "평점", priceCap: "예산", groups: "카테고리" };

/** R41: 완화 토스트 한 줄 (푼 것이 없으면 null). strict = 원래 조건에 맞는 후보 수 (0이면 "없어서", 아니면 "적어서") */
export function relaxNotice(relaxed: RelaxStep[], addedRadius: number, strict: number): string | null {
  const conds = relaxed.filter((s): s is Exclude<RelaxStep, "radius"> => s !== "radius").map((s) => RELAX_LABEL[s]).join("·");
  const wider = relaxed.includes("radius") && addedRadius > 0 ? `반경을 ${addedRadius}m 넓혔어요` : "";
  if (!conds && !wider) return null;
  const head = strict === 0 ? "조건에 맞는 곳이 없어서" : "조건에 맞는 곳이 적어서";
  if (conds && wider) return `${head} ${conds} 조건을 풀고 ${wider}`;
  return conds ? `${head} ${conds} 조건을 풀었어요` : `${head} ${wider}`;
}
