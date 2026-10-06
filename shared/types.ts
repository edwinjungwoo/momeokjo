export type LatLng = { lat: number; lng: number };
export type Rect = { minLat: number; minLng: number; maxLat: number; maxLng: number };

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
  photoUrl: string | null;
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
  photoUrl: string | null;
  url: string;
};

/** D1에 저장된 상세 (서버 안에서만 쓴다) */
export type StoredDetail = PlaceDetail & { fetchedAt: number };

/** API 응답의 상세. 태그 대신 R19 판단 결과만 준다. 목록은 메뉴 3개, 단건은 전부 */
export type ApiDetail = Omit<PlaceDetail, "tags"> & { soloFriendly: boolean; groupFriendly: boolean };

export type ApiPlace = {
  id: string;
  name: string;
  group: CategoryGroup;
  category: string;
  lat: number;
  lng: number;
  distance?: number;
  walkMinutes?: number;
  /** 단건(R13)에만 있다. 목록은 화면이 쓰지 않아서 싣지 않는다 */
  address?: string | null;
  phone?: string | null;
  /** R48: 상세를 가져온 시각 (epoch ms). 단건(R13)에만 있다 — 목록 크기는 그대로 */
  fetchedAt?: number;
  url: string;
  photoUrl: string | null;
  detail: ApiDetail | null;
};

export type PlacesResponse = {
  center: LatLng;
  radius: number;
  places: ApiPlace[];
  pending: number;
  incompleteTiles: number;
  /** 공식 API(격자 수집)가 실패해서 예전 데이터일 수 있다. 요청 제한으로 건너뛴 것은 stale이 아니다 */
  stale: boolean;
  /** R10 쿨다운·R44 frozen으로 상세 가져오기가 멈췄다 — pending이 줄지 않으니 화면은 그것 때문에 다시 부르지 않는다 */
  detailsPaused: boolean;
  /** R44 강등 모드 시작 시각 (아니면 null) */
  detailsFrozenSince: number | null;
  /** R44 실린 가게 중 가장 최근 상세 시각 (없으면 null) */
  detailsNewestAt: number | null;
  /**
   * R63 이 거점에서 마지막으로 다 끝낸 주간 갱신의 날짜 = 그 갱신의 시작(갱신 요일 00:00 KST, epoch ms). 끝낸 시각이 아니다 —
   * 화면은 갱신 요일 날짜를 보여준다. 한 번도 끝내지 않았으면 null, 갱신 중에는 지난번 것.
   * 예전 응답(R63 전 기기 저장본)에는 없다
   */
  refreshedAt?: number | null;
  /** R63 거점의 주 1회 갱신 요일 (KST, 0=일 ~ 6=토 — shared/hubs.ts). 예전 응답에는 없다 */
  refreshDay?: number;
};
