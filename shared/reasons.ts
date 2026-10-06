import { isNew, type Seen } from "./seen";
import type { ApiPlace } from "./types";

/**
 * R46: 결과 3곳에 붙이는 "왜" 한 단어. 3곳(보여주는 곳들) 안에서 글자 그대로 참일 때만 붙인다.
 * 평점이 근거인 "평점 최고"·"가성비"는 리뷰가 REASON_MIN_REVIEWS개 이상인 곳에만.
 * 카드당 최대 하나, 같은 말은 한 카드에만. 동점이면 붙이지 않는다.
 */
export type Reason = "제일 가까워요" | "평점 최고" | "가성비" | "처음 보는 곳";

/** "처음 보는 곳"은 이 기기에서 본 곳이 이만큼은 쌓였을 때만 (처음 쓰는 사람에겐 다 처음이라) */
export const NEW_PLACE_MIN_SEEN = 15;
export const TOP_RATING_MIN = 4.0;
export const VALUE_RATING_MIN = 3.8;
/** "평점 최고"·"가성비"는 평점을 근거로 하니, 리뷰가 이만큼은 있어야 붙인다 (리뷰 몇 개짜리 5.0은 믿기 어려워서) */
export const REASON_MIN_REVIEWS = 20;
/** 예산 필터(R18)와 같은 경계: 1만 이하 / 1.5만 이하 / 2만 이하 / 그 위 */
const PRICE_BANDS = [10000, 15000, 20000];

export const priceBand = (price: number): number => {
  const i = PRICE_BANDS.findIndex((cap) => price <= cap);
  return i === -1 ? PRICE_BANDS.length : i;
};

/** 값을 아는 곳이 min곳 이상이고 best(작을수록 좋음)인 곳이 혼자일 때 그 위치, 아니면 null */
function soleBest(values: (number | null)[], min: number): number | null {
  const known = values.flatMap((v, i) => (v === null ? [] : [{ v, i }]));
  if (known.length < min) return null;
  const best = Math.min(...known.map((x) => x.v));
  const at = known.filter((x) => x.v === best);
  return at.length === 1 ? at[0].i : null;
}

/**
 * seen: 이 결과를 띄우기 *전*의 본 곳 기억(`shared/seen.ts`) — 이번 결과를 기록한 뒤의 것을 넘기면 "처음 보는 곳"이 사라진다.
 * outside: R41 완화로 들어온 곳. 그 카드는 "조건 밖" 표시 하나만 두고 이유는 붙이지 않는다(다른 카드에 넘기지도 않는다 — 그건 참이 아니라서).
 * 순서(가까움 → 평점 → 가성비 → 처음)대로 그 이유의 주인이 아직 이유가 없으면 붙인다.
 */
export function trioReasons(
  places: ApiPlace[], ctx: { seen: Seen; outside?: ReadonlySet<string> },
): (Reason | null)[] {
  const out: (Reason | null)[] = places.map(() => null);
  if (places.length < 2) return out;
  const rating = (p: ApiPlace) => p.detail?.rating ?? null;
  const price = (p: ApiPlace) => p.detail?.price ?? null;

  const enough = Object.keys(ctx.seen).length >= NEW_PLACE_MIN_SEEN;
  const fresh = places.map((p) => (enough && isNew(ctx.seen, p.id) ? 0 : null));

  const candidates: [Reason, number | null][] = [
    // 도보 분을 모르는 곳이 하나라도 있으면 "제일 가까워요"라고 할 수 없다
    ["제일 가까워요", soleBest(places.map((p) => p.walkMinutes ?? null), places.length)],
    ["평점 최고", soleBest(places.map((p) => { const r = rating(p); return r === null ? null : -r; }), 2)],
    ["가성비", soleBest(places.map((p) => { const v = price(p); return v === null ? null : priceBand(v); }), 2)],
    ["처음 보는 곳", soleBest(fresh, 1)],
  ];
  for (const [reason, i] of candidates) {
    if (i === null || out[i] !== null) continue;
    const r = rating(places[i]);
    const reviews = places[i].detail?.reviewCount ?? null;
    const reliable = reviews !== null && reviews >= REASON_MIN_REVIEWS;
    if (reason === "평점 최고" && (r === null || r < TOP_RATING_MIN || !reliable)) continue;
    if (reason === "가성비" && (r === null || r < VALUE_RATING_MIN || !reliable)) continue;
    out[i] = reason;
  }
  return out.map((r, i) => (ctx.outside?.has(places[i].id) ? null : r));
}
