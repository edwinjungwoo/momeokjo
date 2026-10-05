import { groupFriendly, soloFriendly } from "../shared/friendly";
import { haversine, walkMinutes } from "../shared/geo";
import type { ApiPlace, LatLng } from "../shared/types";
import type { PlaceRow } from "./repo";

/** 목록 응답에 싣는 메뉴 수 (카드를 열면 단건 조회로 전부 받는다) */
export const LIST_MENUS = 3;

/** R12 목록 원소(center로 거리 계산, 메뉴 3개) / R13 단건(full: 메뉴 전부) */
export function toApiPlace(row: PlaceRow, opts: { center?: LatLng; full?: boolean } = {}): ApiPlace {
  const p = row.place;
  const d = row.detail;
  const distance = opts.center ? Math.round(haversine(opts.center, p)) : undefined;
  return {
    id: p.id,
    name: p.name,
    group: p.group,
    category: p.categoryName,
    lat: p.lat,
    lng: p.lng,
    ...(distance === undefined ? {} : { distance, walkMinutes: walkMinutes(distance) }),
    address: p.address,
    phone: p.phone,
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
