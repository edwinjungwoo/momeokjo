import { describe, expect, it } from "vitest";

// 화면 스타일 원문 (Vite가 테스트 빌드 시점에 묶어 준다)
const css = Object.values(
  import.meta.glob("../../web/styles.css", { query: "?raw", import: "default", eager: true }),
)[0] as string;

/** 주석을 지운 뒤 `선택자 { 선언 }` 규칙들 (@media 안 규칙도 평평하게) */
function rules(text: string): { selector: string; body: string }[] {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  for (const m of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

// 보이는 알약은 36px, 누르는 영역은 위아래 투명 테두리로 44px — background-clip: padding-box에 기대는 요소들
const PILL = /(^|[\s,])(\.chip|\.sort|\.hub-chip > button)(?![-\w])/;

describe("R30: 알약 모양 버튼의 보이는 높이", () => {
  it("R30: 칩·정렬·거점 칩의 어떤 상태 규칙도 background 줄임말로 background-clip을 border-box로 되돌리지 않는다", () => {
    const pills = rules(css).filter((r) => PILL.test(r.selector));
    expect(pills.length).toBeGreaterThan(3);
    const offenders = pills
      .filter((r) => {
        const decls = r.body.split(";").map((d) => d.trim()).filter(Boolean);
        let lastShorthand = -1;
        decls.forEach((d, i) => {
          if (/^background\s*:/.test(d)) lastShorthand = i;
        });
        if (lastShorthand < 0) return false;
        // 줄임말 뒤에 background-clip: padding-box가 다시 와야 한다
        return !decls.slice(lastShorthand + 1).some((d) => /^background-clip\s*:\s*padding-box/.test(d));
      })
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });
});
