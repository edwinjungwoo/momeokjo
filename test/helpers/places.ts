import type { CategoryGroup, PlaceDetail, PlaceSummary } from "../../shared/types";
import { saveDetail } from "../../worker/repo";
import jungang from "../fixtures/place-detail/27531028-jungang-haejang.json";

export const CATEGORY_NAME: Record<CategoryGroup, string> = {
  korean: "음식점 > 한식 > 국밥",
  chinese: "음식점 > 중식",
  japanese: "음식점 > 일식",
  western: "음식점 > 양식",
  asian: "음식점 > 아시아음식",
  snack: "음식점 > 분식",
  bar: "음식점 > 술집",
  dessert: "음식점 > 간식",
  etc: "음식점 > 뷔페",
};

export function makeSummary(lat: number, lng: number, opts: { group?: CategoryGroup; name?: string } = {}): PlaceSummary {
  return {
    name: opts.name ?? "가게",
    categoryName: CATEGORY_NAME[opts.group ?? "korean"],
    lat,
    lng,
    address: "서울 강남구 영동대로 1",
    phone: null,
  };
}

export function sampleDetail(overrides: Partial<PlaceDetail> = {}): PlaceDetail {
  return {
    rating: 4.2,
    reviewCount: 100,
    price: 12000,
    menus: [{ name: "국밥", price: 12000 }],
    hours: { 1: [[660, 1320]] },
    strengths: ["맛"],
    bookable: false,
    tags: ["혼밥"],
    ...overrides,
  };
}

export async function seedPlace(
  db: D1Database,
  id: string,
  lat: number,
  lng: number,
  opts: { group?: CategoryGroup; name?: string; detail?: Partial<PlaceDetail>; now?: number } = {},
): Promise<void> {
  await saveDetail(db, id, makeSummary(lat, lng, { group: opts.group, name: opts.name ?? `가게${id}` }), sampleDetail(opts.detail), opts.now ?? 0);
}

/** 실제 중앙해장 상세 응답에서 이름, 좌표, 카테고리만 바꾼 가짜 상세 응답 */
export function placeJson(opts: { name: string; lat: number; lng: number; category?: [string, string, string?] }) {
  const [name1, name2, name3] = opts.category ?? ["음식점", "한식", "해장국"];
  return {
    ...jungang,
    summary: {
      ...jungang.summary,
      name: opts.name,
      point: { lat: opts.lat, lng: opts.lng },
      category: { ...jungang.summary.category, name1, name2, name3: name3 ?? null },
    },
  };
}
