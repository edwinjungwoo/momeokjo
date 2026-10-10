import { describe, expect, expectTypeOf, it } from "vitest";
import { FILTER_GROUPS, GROUP_GLYPH, GROUP_LABEL, categoryGroup, lastLevel, secondLevel, type FilterGroup } from "../../shared/category";
import { parseSettings } from "../../shared/settings";

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

describe("R33 사진 없는 자리의 카테고리 아이콘 (지도 칩과 같은 것)", () => {
  it("R33: 모든 그룹에 아이콘이 하나씩 있다 — 한식 🍚 중식 🥟 일식 🍣 양식 🍝 아시안 🍜 분식·패스트푸드 🍔 술집 🍺", () => {
    expect(GROUP_GLYPH).toEqual({
      korean: "🍚", chinese: "🥟", japanese: "🍣", western: "🍝", asian: "🍜", snack: "🍔", bar: "🍺", dessert: "🍰", etc: "🍴",
    });
  });

  it("R5/R18: 카테고리 칩 그룹(FILTER_GROUPS)은 술집·디저트를 뺀 7개 — 타입도 그 7개뿐이고, 칩마다 라벨이 있고, 설정 복원도 이 목록만 받는다", () => {
    expect(FILTER_GROUPS).toEqual(["korean", "chinese", "japanese", "western", "asian", "snack", "etc"]);
    expectTypeOf<FilterGroup>().toEqualTypeOf<"korean" | "chinese" | "japanese" | "western" | "asian" | "snack" | "etc">();
    for (const g of FILTER_GROUPS) expect(GROUP_LABEL[g], g).toBeTruthy();
    expect(parseSettings(JSON.stringify({ filters: { groups: [...FILTER_GROUPS] } })).filters.groups).toEqual([...FILTER_GROUPS]);
    for (const g of ["bar", "dessert"]) expect(parseSettings(JSON.stringify({ filters: { groups: [g] } })).filters.groups, g).toEqual([]);
  });
});
