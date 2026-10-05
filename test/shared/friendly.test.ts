import { describe, expect, it } from "vitest";
import { groupFriendly, soloFriendly } from "../../shared/friendly";

describe("friendly", () => {
  it("R19: 혼밥 친화 — 카테고리에 국밥·라멘 등 키워드가 있거나 태그에 '혼밥'", () => {
    expect(soloFriendly("음식점 > 한식 > 국밥", [])).toBe(true);
    expect(soloFriendly("음식점 > 일식 > 라멘", [])).toBe(true);
    expect(soloFriendly("음식점 > 한식", ["혼밥"])).toBe(true);
    expect(soloFriendly("음식점 > 한식", ["단체석"])).toBe(false);
  });
  it("R19: 단체 친화 — 태그에 단체석/회식장소/모임맛집 중 하나", () => {
    expect(groupFriendly(["회식장소"])).toBe(true);
    expect(groupFriendly(["모임맛집", "혼밥"])).toBe(true);
    expect(groupFriendly(["혼밥"])).toBe(false);
    expect(groupFriendly([])).toBe(false);
  });
});
