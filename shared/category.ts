import type { CategoryGroup } from "./types";

const SECOND_LEVEL_GROUP: Record<string, CategoryGroup> = {
  한식: "korean",
  중식: "chinese",
  일식: "japanese",
  양식: "western",
  패밀리레스토랑: "western",
  아시아음식: "asian",
  분식: "snack",
  패스트푸드: "snack",
  도시락: "snack",
  술집: "bar",
  간식: "dessert",
};

const levels = (categoryName: string) =>
  categoryName.split(">").map((s) => s.trim()).filter(Boolean);

export function secondLevel(categoryName: string): string {
  return levels(categoryName)[1] ?? "";
}

export function lastLevel(categoryName: string): string {
  const l = levels(categoryName);
  return l[l.length - 1] ?? "";
}

export function categoryGroup(categoryName: string): CategoryGroup {
  return SECOND_LEVEL_GROUP[secondLevel(categoryName)] ?? "etc";
}

export const GROUP_LABEL: Record<Exclude<CategoryGroup, "dessert">, string> = {
  korean: "한식",
  chinese: "중식",
  japanese: "일식",
  western: "양식",
  asian: "아시안",
  snack: "분식·패스트푸드",
  bar: "술집",
  etc: "기타",
};

/** 그룹 아이콘: 지도 칩("🍚 4.3")과 사진 없는 썸네일 자리(목록 행·결과 카드)에 같은 것을 쓴다 (R28, R33) */
export const GROUP_GLYPH: Record<CategoryGroup, string> = {
  korean: "🍚",
  chinese: "🥟",
  japanese: "🍣",
  western: "🍝",
  asian: "🍜",
  snack: "🍔",
  bar: "🍺",
  dessert: "🍰",
  etc: "🍴",
};

/** 카테고리 칩으로 노출하는 그룹 (술집은 별도 토글, 디저트는 목록에 없다). 설정 복원·이벤트 검증도 이 목록 하나를 쓴다 */
export const FILTER_GROUPS = [
  "korean", "chinese", "japanese", "western", "asian", "snack", "etc",
] as const satisfies readonly Exclude<CategoryGroup, "bar" | "dessert">[];
export type FilterGroup = (typeof FILTER_GROUPS)[number];
