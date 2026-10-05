import type { ApiPlace } from "../../shared/types";

/** "★ 4.3 (320)" — 별은 이모지 대신 글자 기호, 숫자는 강조색 */
export function Rating({ p, className }: { p: ApiPlace; className?: string }) {
  const r = p.detail?.rating ?? null;
  if (r === null) return <span className={`rating is-none${className ? ` ${className}` : ""}`}>평점 정보 없음</span>;
  return (
    <span className={`rating${className ? ` ${className}` : ""}`}>
      <span className="star" aria-hidden="true">
        ★
      </span>
      <b>{r.toFixed(1)}</b>
      <span className="count">({(p.detail?.reviewCount ?? 0).toLocaleString("ko-KR")})</span>
    </span>
  );
}
