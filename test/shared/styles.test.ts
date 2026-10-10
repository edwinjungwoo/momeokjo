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

describe("R28: 지도 핀이 카카오 기본 지도 아이콘과 섞이지 않는다", () => {
  const rule = (sel: string) => rules(css).find((r) => r.selector === sel)?.body ?? "";
  it("R28: 멀리서 본 점은 진한 브랜드 오렌지(#E8512A) + 흰 테두리 2px + 옅은 그림자, 크기는 작게(색 부분 8px 이하)", () => {
    const dot = rule(".pin::before");
    expect(dot).toMatch(/background:\s*var\(--accent-strong\)/);
    expect(dot).toMatch(/border:\s*2px solid #fff/);
    expect(dot).toMatch(/box-shadow:/);
    const w = Number(/(?:^|;)\s*width:\s*(\d+)px/.exec(dot)?.[1]);
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThanOrEqual(8);
  });
  it("R28: 가까이 본 칩도 옅은 그림자로 지도 글자와 구분한다", () => {
    expect(rule(".pin-chip")).toMatch(/box-shadow:/);
  });
});

describe("R28: 화면 높이(dvh) 폴백", () => {
  it("R28: dvh를 쓰는 선언마다 같은 규칙 앞에 vh로 쓴 같은 속성이 있다 (dvh를 모르는 브라우저는 그 줄을 버려서 높이 상한이 없어진다)", () => {
    const missing = rules(css).flatMap((r) => {
      const decls = r.body.split(";").map((d) => d.trim()).filter(Boolean);
      const prop = (d: string) => d.slice(0, d.indexOf(":")).trim();
      return decls.flatMap((d, i) => {
        if (!/\ddvh\b/.test(d)) return [];
        const fallback = decls.slice(0, i).some((e) => prop(e) === prop(d) && /\dvh\b/.test(e) && !/dvh/.test(e));
        return fallback ? [] : [`${r.selector} { ${d} }`];
      });
    });
    expect(rules(css).some((r) => /\ddvh\b/.test(r.body))).toBe(true);
    expect(missing).toEqual([]);
  });
});
