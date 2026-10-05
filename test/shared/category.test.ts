import { describe, expect, it } from "vitest";
import { categoryGroup, lastLevel, secondLevel } from "../../shared/category";

describe("category", () => {
  it.each([
    ["음식점 > 한식 > 해장국", "korean"],
    ["음식점 > 한식", "korean"],
    ["음식점 > 중식 > 중국요리", "chinese"],
    ["음식점 > 일식 > 일식집", "japanese"],
    ["음식점 > 양식 > 햄버거", "western"],
    ["음식점 > 패밀리레스토랑 > 아웃백스테이크하우스", "western"],
    ["음식점 > 아시아음식", "asian"],
    ["음식점 > 분식", "snack"],
    ["음식점 > 패스트푸드 > KFC", "snack"],
    ["음식점 > 도시락", "snack"],
    ["음식점 > 술집 > 일본식주점", "bar"],
    ["음식점 > 간식 > 제과,베이커리", "dessert"],
    ["음식점 > 뷔페 > 해산물뷔페", "etc"],
    ["음식점 > 치킨", "etc"],
    ["음식점", "etc"],
    ["", "etc"],
  ])("R5: '%s' → %s", (name, group) => {
    expect(categoryGroup(name)).toBe(group);
  });

  it("R5: secondLevel / lastLevel", () => {
    expect(secondLevel("음식점 > 한식 > 육류,고기 > 곱창,막창")).toBe("한식");
    expect(lastLevel("음식점 > 한식 > 육류,고기 > 곱창,막창")).toBe("곱창,막창");
    expect(secondLevel("음식점")).toBe("");
    expect(lastLevel("음식점")).toBe("음식점");
  });
});
