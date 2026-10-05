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

/** 카테고리 칩으로 노출하는 그룹 (술집은 별도 토글) */
export const FILTER_GROUPS: CategoryGroup[] = ["korean", "chinese", "japanese", "western", "asian", "snack", "etc"];
