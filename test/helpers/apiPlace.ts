import type { ApiDetail, ApiPlace } from "../../shared/types";

export function apiPlace(id: string, overrides: Partial<ApiPlace> = {}, detail: Partial<ApiDetail> | null = {}): ApiPlace {
  return {
    id,
    name: `가게${id}`,
    group: "korean",
    category: "음식점 > 한식",
    lat: 37.513,
    lng: 127.06,
    distance: 100,
    walkMinutes: 2,
    address: null,
    phone: null,
    url: `http://place.map.kakao.com/${id}`,
    detail:
      detail === null
        ? null
        : {
            rating: 4.0,
            reviewCount: 90,
            price: 12000,
            menus: [],
            hours: null,
            strengths: [],
            bookable: null,
            tags: [],
            fetchedAt: 0,
            ...detail,
          },
    ...overrides,
  };
}
