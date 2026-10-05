import { MAX_RADIUS } from "../../shared/constants";
import { withRadius, type Filters } from "../../shared/recommend";
import { Mascot } from "./Mascot";

type Relax = { label: string; apply: (f: Filters) => Filters };

/** 지금 켜져 있는 제약만 풀기 버튼으로 보여준다 (R21 반경 넓히기 포함) */
export function relaxOptions(f: Filters): Relax[] {
  const out: Relax[] = [];
  if (f.openOnly) out.push({ label: "영업 중만 해제", apply: (x) => ({ ...x, openOnly: false }) });
  if (f.minRating > 0) out.push({ label: "평점 무관", apply: (x) => ({ ...x, minRating: 0 }) });
  if (f.priceCap !== "all") out.push({ label: "예산 전체", apply: (x) => ({ ...x, priceCap: "all" }) });
  if (f.groups.length > 0) out.push({ label: "카테고리 전체", apply: (x) => ({ ...x, groups: [] }) });
  if (f.radius < MAX_RADIUS) {
    out.push({ label: "반경 +300m", apply: (x) => withRadius(x, Math.min(MAX_RADIUS, x.radius + 300)) });
  }
  return out;
}

export function EmptyState({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const options = relaxOptions(filters);
  return (
    <div className="state" id="empty" role="status">
      <p className="bubble">앗… 조건에 맞는 맛집이 없어요</p>
      <Mascot pose="sad" height={96} />
      <p className="state-desc">
        {options.length > 0 ? "다른 조건으로 다시 찾아볼까요?" : "기준점을 옮겨서 다시 찾아볼까요?"}
      </p>
      {options.length > 0 && (
        <div className="state-actions">
          {options.map((o) => (
            <button key={o.label} type="button" className="chip" onClick={() => onChange(o.apply(filters))}>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="state" role="alert">
      <Mascot pose="warning" height={96} />
      <p className="state-title">앗! 일시적인 오류가 발생했어요.</p>
      <p className="state-desc">잠시 후 다시 시도해주세요.</p>
      <div className="state-actions">
        <button type="button" className="btn-tint" onClick={onRetry}>
          다시 시도하기
        </button>
      </div>
    </div>
  );
}
