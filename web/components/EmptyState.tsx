import { MAX_RADIUS } from "../../shared/constants";
import { withRadius, type Filters } from "../../shared/recommend";

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
    <div className="empty" id="empty" role="status">
      <img
        className="mascot"
        src="/brand/pose-find.png"
        alt=""
        aria-hidden="true"
        width={98}
        height={96}
        loading="lazy"
        draggable={false}
      />
      <p className="empty-title">점심시간이 코앞인데 후보가 없네요</p>
      <p className="empty-desc">{options.length > 0 ? "조건을 하나만 풀어볼까요?" : "기준점을 옮겨보세요"}</p>
      {options.length > 0 && (
        <div className="empty-actions">
          {options.map((o) => (
            <button key={o.label} type="button" className="btn-ghost accent" onClick={() => onChange(o.apply(filters))}>
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
    <div className="empty" role="alert">
      <p className="empty-title">가게 정보를 불러오지 못했어요</p>
      <p className="empty-desc">잠시 뒤에 다시 시도해 주세요</p>
      <div className="empty-actions">
        <button type="button" className="btn-ghost accent" onClick={onRetry}>
          다시 시도
        </button>
      </div>
    </div>
  );
}
