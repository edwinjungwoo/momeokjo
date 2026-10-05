import { describe, expect, it } from "vitest";

// 정적 파일 원문 (Vite가 테스트 빌드 시점에 묶어 준다)
const files = import.meta.glob("../../public/{robots.txt,_headers}", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

/** _headers에서 경로 한 줄 뒤에 들여 쓴 헤더들 */
function headersFor(text: string, path: string): string[] {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim() === path && !/^\s/.test(l));
  if (i < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(i + 1)) {
    if (!/^\s+\S/.test(l)) break;
    out.push(l.trim());
  }
  return out;
}

describe("검색 노출", () => {
  it("R36: robots.txt는 /admin과 /api/를 막는다", () => {
    const robots = files["../../public/robots.txt"];
    expect(robots).toBeDefined();
    const lines = robots.split("\n").map((l) => l.trim());
    expect(lines).toContain("User-agent: *");
    expect(lines).toContain("Disallow: /admin");
    expect(lines).toContain("Disallow: /api/");
  });

  it("R36/R45: /admin 응답에는 X-Robots-Tag: noindex를 붙이고, 기존 캐시 규칙은 그대로다", () => {
    const h = files["../../public/_headers"];
    expect(headersFor(h, "/admin")).toContain("X-Robots-Tag: noindex");
    expect(headersFor(h, "/assets/*")).toEqual(["Cache-Control: public, max-age=31536000, immutable"]);
  });
});
