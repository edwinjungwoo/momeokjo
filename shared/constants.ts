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
/** ok TTL에 id별로 더하는 0~24시간 지터 (한꺼번에 수집한 가게들이 같은 시각에 만료되지 않게) */
export const DETAIL_JITTER_MS = 24 * HOUR;
/** 상세 API가 403/429를 주면 이 시간 동안 모든 상세 호출을 멈춘다 */
export const PLACE_BLOCK_COOLDOWN_MS = 30 * 60_000;

export const MAX_QUAD_DEPTH = 4;
export const KAKAO_PAGE_SIZE = 15;
export const KAKAO_MAX_RESULTS = 45;
