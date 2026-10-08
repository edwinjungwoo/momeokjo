import { hubLines } from "../hubLines";

/** 역 이름 옆 호선 배지 — 숫자 노선은 동그라미, 이름 노선(신분당·경강)은 둥근 네모. 읽기 도구에는 "2호선, 신분당선" */
export function LineBadges({ hubId }: { hubId: string }) {
  const lines = hubLines(hubId);
  if (lines.length === 0) return null;
  return (
    <span className="line-badges" aria-label={lines.map((l) => l.name).join(", ")}>
      {lines.map((l) => (
        <span
          key={l.name}
          className={`line-badge${l.label.length > 1 ? " is-named" : ""}`}
          style={{ background: l.color }}
          aria-hidden="true"
        >
          {l.label}
        </span>
      ))}
    </span>
  );
}
