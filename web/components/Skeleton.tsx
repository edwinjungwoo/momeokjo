import { Mascot } from "./Mascot";

/** R29 첫 로딩: 마스코트 + 안내 + 얇은 진행 막대, 그 아래 결과 카드 모양의 스켈레톤 */
export function SkeletonList({ title, desc, rows = 3 }: { title: string; desc: string; rows?: number }) {
  return (
    <div className="skeleton" role="status" aria-busy="true">
      <div className="state">
        <Mascot pose="waiting" height={80} />
        <p className="state-title">{title}</p>
        <p className="state-desc">{desc}</p>
        <span className="progress" aria-hidden="true" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton-row" aria-hidden="true">
          <i />
          <span>
            <i />
            <i />
          </span>
        </span>
      ))}
    </div>
  );
}
