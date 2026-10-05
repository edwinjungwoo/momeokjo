export type LatLng = { lat: number; lng: number };
export type Rect = { minLat: number; minLng: number; maxLat: number; maxLng: number };
export type LunchMinutes = 30 | 60 | 90;

export type CategoryGroup =
  | "korean" | "chinese" | "japanese" | "western" | "asian" | "snack" | "bar" | "dessert" | "etc";

/** [openMinute, closeMinute] — 자정을 넘기면 close > 1440 */
export type Interval = [number, number];
/** key: 요일 0(일)~6(토) */
export type Hours = Record<number, Interval[] | "closed">;

export type Menu = { name: string; price: number };

export type PlaceDetail = {
  rating: number | null;
  reviewCount: number | null;
  price: number | null;
  menus: Menu[];
  hours: Hours | null;
  strengths: string[];
  bookable: boolean | null;
  tags: string[];
};

export type PlaceSummary = {
  name: string;
  categoryName: string;
  lat: number;
  lng: number;
  address: string | null;
  phone: string | null;
};

export type Place = {
  id: string;
  name: string;
  categoryName: string;
  group: CategoryGroup;
  lat: number;
  lng: number;
  address: string | null;
  phone: string | null;
  url: string;
};

export type ApiDetail = PlaceDetail & { fetchedAt: number };

export type ApiPlace = {
  id: string;
  name: string;
  group: CategoryGroup;
  category: string;
  lat: number;
  lng: number;
  distance?: number;
  walkMinutes?: number;
  address: string | null;
  phone: string | null;
  url: string;
  detail: ApiDetail | null;
};

export type PlacesResponse = {
  center: LatLng;
  radius: number;
  places: ApiPlace[];
  pending: number;
  incompleteTiles: number;
  stale: boolean;
};
