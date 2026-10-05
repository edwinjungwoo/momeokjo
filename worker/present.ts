import { groupFriendly, soloFriendly } from "../shared/friendly";
import { haversine, walkMinutes } from "../shared/geo";
import type { ApiPlace, LatLng, PlacesResponse } from "../shared/types";
import type { PlaceRow } from "./repo";

/** 목록 응답에 싣는 메뉴 수 (카드를 열면 단건 조회로 전부 받는다) */
export const LIST_MENUS = 3;

/** R45: 좌표는 소수 6자리(약 0.1m)면 충분하다. 카카오 원본의 17자리는 압축이 안 돼서 1000m 목록 gzip의 1할을 차지했다 */
const coord = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * R12 목록 원소(거리, 메뉴 3개, 주소·전화 없음) / R13 단건(full: 메뉴 전부, 주소·전화, R48 상세 시각 포함).
 * distance를 이미 계산했으면 넘겨서 다시 계산하지 않는다.
 */
export function toApiPlace(
  row: PlaceRow, opts: { center?: LatLng; distance?: number; full?: boolean } = {},
): ApiPlace {
  const p = row.place;
  const d = row.detail;
  const distance =
    opts.distance !== undefined ? Math.round(opts.distance) : opts.center ? Math.round(haversine(opts.center, p)) : undefined;
  return {
    id: p.id,
    name: p.name,
    group: p.group,
    category: p.categoryName,
    lat: coord(p.lat),
    lng: coord(p.lng),
    ...(distance === undefined ? {} : { distance, walkMinutes: walkMinutes(distance) }),
    ...(opts.full ? { address: p.address, phone: p.phone, fetchedAt: d.fetchedAt } : {}),
    url: p.url,
    photoUrl: p.photoUrl,
    detail: {
      rating: d.rating,
      reviewCount: d.reviewCount,
      price: d.price,
      menus: opts.full ? d.menus : d.menus.slice(0, LIST_MENUS),
      hours: d.hours,
      strengths: d.strengths,
      bookable: d.bookable,
      soloFriendly: soloFriendly(p.categoryName, d.tags),
      groupFriendly: groupFriendly(d.tags),
    },
  };
}

/**
 * R12 목록 원소 조각: 거리·도보 분이 없는 목록 원소 JSON. 상세를 저장할 때 places.list_json에 같이 쓴다 (0005).
 * 목록은 이 조각에 withDistance로 거리만 붙여서 JSON 열 4개를 다시 읽지(JSON.parse) 않는다.
 */
export const listItemJson = (row: PlaceRow): string => JSON.stringify(toApiPlace(row));

/** 조각 앞에 거리·도보 분을 붙인다 (값은 toApiPlace(row, { distance })와 같다 — 키 순서만 다르다) */
export function withDistance(itemJson: string, distanceM: number): string {
  const distance = Math.round(distanceM);
  return `{"distance":${distance},"walkMinutes":${walkMinutes(distance)},${itemJson.slice(1)}`;
}

export type PlacesMeta = Omit<PlacesResponse, "places">;

/** R12 응답 본문: 메타 필드와 목록 조각을 이어 붙인다 (JSON.parse하면 PlacesResponse) */
export function placesBody(meta: PlacesMeta, items: string[]): string {
  const { center, radius, ...rest } = meta;
  const head = JSON.stringify({ center, radius }).slice(0, -1);
  const tail = JSON.stringify(rest).slice(1);
  return `${head},"places":[${items.join(",")}],${tail}`;
}
