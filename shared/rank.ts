import { REASON_MIN_REVIEWS } from "./reasons";
import type { ApiPlace } from "./types";

/** R51: 순위 점수에 섞는 지역 평균의 무게 (리뷰 이만큼 있는 셈) */
export const RANK_PRIOR_REVIEWS = 20;
/** R34: 이 백분율 이하만 "근처 상위 N%"로 보여준다 */
export const RANK_TOP_LIMIT = 30;

/**
 * R34: 지금 거점·반경 안의 전체 목록(필터 적용 전)에서 평점 백분위를 구한다.
 * R42: 화면은 거점의 1000m 목록을 받으므로 radius(화면 반경) 안의 가게만 센다. 거리가 없으면 반경 밖으로 본다.
 * R51: 대상은 평점이 있는 곳. 순위는 리뷰 수로 보정한 평점 (v × R + m × C) / (v + m)으로 매긴다
 * (v = 리뷰 수(없으면 0), R = 평점, C = 대상 평점 평균, m = 20). 리뷰 6개짜리 5.0점이 1위가 되지 않게 한다.
 * 보이는 별점은 원래 값 그대로이고 이 점수는 순위에만 쓴다. 같은 점수는 더 좋은 순위를 함께 쓴다.
 * 리뷰가 REASON_MIN_REVIEWS(20)개 미만이거나 수를 모르는 곳은 대상 수(n)·평균(C)·순위 자리에는 그대로 들어가지만
 * 자기 알약은 달지 않는다 ("평점 최고"와 같은 문턱 — 근거가 별점 몇 개뿐이라).
 * 반환: id → 상위 N% (1~30). 대상이 아니거나, 리뷰가 20개 미만이거나, 30%를 넘으면 넣지 않는다.
 */
export function topPercents(places: ApiPlace[], radius = Infinity): Map<string, number> {
  const rated: { id: string; rating: number; reviews: number }[] = [];
  for (const p of places) {
    if (radius !== Infinity && (p.distance ?? Infinity) > radius) continue;
    const rating = p.detail?.rating ?? null;
    if (rating !== null) rated.push({ id: p.id, rating, reviews: Math.max(0, p.detail?.reviewCount ?? 0) });
  }
  const out = new Map<string, number>();
  const n = rated.length;
  if (n === 0) return out;
  const mean = rated.reduce((a, x) => a + x.rating, 0) / n;
  const m = RANK_PRIOR_REVIEWS;
  const scored = rated.map((x) => ({ id: x.id, reviews: x.reviews, score: (x.reviews * x.rating + m * mean) / (x.reviews + m) }));
  scored.sort((a, b) => b.score - a.score);
  let rank = 1;
  for (let i = 0; i < n; i++) {
    if (i > 0 && scored[i].score < scored[i - 1].score) rank = i + 1;
    const top = Math.max(1, Math.ceil((rank / n) * 100));
    if (top > RANK_TOP_LIMIT) break;
    if (scored[i].reviews >= REASON_MIN_REVIEWS) out.set(scored[i].id, top);
  }
  return out;
}
