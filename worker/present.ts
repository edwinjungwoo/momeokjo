import { haversine, walkMinutes } from "../shared/geo";
import type { ApiPlace, LatLng } from "../shared/types";
import type { PlaceRow } from "./repo";

const API_MENUS = 5;

export function toApiPlace(row: PlaceRow, center?: LatLng): ApiPlace {
  const p = row.place;
  const distance = center ? Math.round(haversine(center, p)) : undefined;
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
    detail: { ...row.detail, menus: row.detail.menus.slice(0, API_MENUS) },
  };
}
