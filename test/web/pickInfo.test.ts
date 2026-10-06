import { describe, expect, it } from "vitest";
import { RELAX_ORDER } from "../../shared/recommend";
import { PICK_INFO_LINES } from "../../web/pickInfo";

describe("R64 모먹죠는 이렇게 골라요", () => {
  it("R64: 최대 5줄, 모두 해요체 문장으로 끝난다", () => {
    expect(PICK_INFO_LINES.length).toBeGreaterThan(0);
    expect(PICK_INFO_LINES.length).toBeLessThanOrEqual(5);
    for (const line of PICK_INFO_LINES) expect(line).toMatch(/요\.$/);
  });

  it("R64: 조건을 푸는 순서 문구가 relaxToFill의 RELAX_ORDER와 같다 (평점→예산→카테고리→반경)", () => {
    const label = { minRating: "평점", priceCap: "예산", groups: "카테고리", radius: "반경" } as const;
    const order = RELAX_ORDER.map((s) => label[s]).join("→");
    expect(order).toBe("평점→예산→카테고리→반경");
    expect(PICK_INFO_LINES.some((l) => l.includes(order))).toBe(true);
  });

  it("R64: 기록은 이 기기에만 남는다는 말이 있고, 조건 밖 표시와 영업 중 조건을 말한다", () => {
    const all = PICK_INFO_LINES.join("\n");
    expect(all).toContain("이 기기에만");
    expect(all).toContain("서버로 보내지 않아요");
    expect(all).toContain("'조건 밖'");
    expect(all).toContain("영업 중");
  });
});
