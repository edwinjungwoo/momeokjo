import type { ApiPlace } from "../../shared/types";
import { ratingTone } from "../format";

/** "★ 4.3 (320)" — 별은 이모지 대신 글자 기호, 숫자는 4.0 이상만 강조색 (그 아래는 차분한 글자색, R28) */
export function Rating({ p, className }: { p: ApiPlace; className?: string }) {
  const r = p.detail?.rating ?? null;
  if (r === null) return <span className={`rating is-none${className ? ` ${className}` : ""}`}>평점 정보 없음</span>;
  return (
    <span className={`rating${ratingTone(r) === "plain" ? " is-plain" : ""}${className ? ` ${className}` : ""}`}>
      <span className="star" aria-hidden="true">
        ★
      </span>
      <b>{r.toFixed(1)}</b>
      <span className="count">({(p.detail?.reviewCount ?? 0).toLocaleString("ko-KR")})</span>
    </span>
  );
}
