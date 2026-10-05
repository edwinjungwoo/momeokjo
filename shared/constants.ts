import type { LatLng, LunchMinutes } from "./types";

export const ASEM: LatLng = { lat: 37.513059, lng: 127.059826 };
export const TILE_LAT = 0.00225;
export const TILE_LNG = 0.0028;
export const LUNCH_RADIUS: Record<LunchMinutes, number> = { 30: 300, 60: 700, 90: 1200 };
export const PREWARM_RADIUS = 1500;
export const MIN_RADIUS = 100;
export const MAX_RADIUS = 2000;

const HOUR = 3600_000;
export const TILE_TTL_MS = 7 * 24 * HOUR;
export const DETAIL_OK_TTL_MS = 3 * 24 * HOUR;
export const DETAIL_FAIL_TTL_MS = 6 * HOUR;

export const MAX_QUAD_DEPTH = 4;
export const KAKAO_PAGE_SIZE = 15;
export const KAKAO_MAX_RESULTS = 45;
