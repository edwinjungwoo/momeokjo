/** R34: 지금 거점·반경 안에서 평점 상위 N% (30% 이하만) */
export function RankPill({ top }: { top: number | undefined }) {
  if (top === undefined) return null;
  return <span className="rank-pill">근처 상위 {top}%</span>;
}
