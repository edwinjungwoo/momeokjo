import type { ApiPlace } from "./types";

/** R34: 리뷰가 이만큼은 있어야 순위에 넣는다 */
export const RANK_MIN_REVIEWS = 5;
/** R34: 이 백분율 이하만 "근처 상위 N%"로 보여준다 */
export const RANK_TOP_LIMIT = 30;

/**
 * R34: 지금 거점·반경 안의 전체 목록(필터 적용 전)에서 평점 백분위를 구한다.
 * 대상은 평점이 있고 리뷰가 5개 이상인 곳. 같은 평점은 더 좋은 순위를 함께 쓴다.
 * 반환: id → 상위 N% (1~30). 대상이 아니거나 30%를 넘으면 넣지 않는다.
 */
export function topPercents(places: ApiPlace[]): Map<string, number> {
  const eligible: { id: string; rating: number }[] = [];
  for (const p of places) {
    const rating = p.detail?.rating ?? null;
    const reviews = p.detail?.reviewCount ?? null;
    if (rating !== null && reviews !== null && reviews >= RANK_MIN_REVIEWS) eligible.push({ id: p.id, rating });
  }
  const out = new Map<string, number>();
  const n = eligible.length;
  if (n === 0) return out;
  eligible.sort((a, b) => b.rating - a.rating);
  let rank = 1;
  for (let i = 0; i < n; i++) {
    if (i > 0 && eligible[i].rating < eligible[i - 1].rating) rank = i + 1;
    const top = Math.max(1, Math.ceil((rank / n) * 100));
    if (top > RANK_TOP_LIMIT) break;
    out.set(eligible[i].id, top);
  }
  return out;
}
