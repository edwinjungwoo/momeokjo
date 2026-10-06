import type { LatLng } from "./types";

/** 테스트 기준점 (서비스 거점은 shared/hubs.ts) */
export const ASEM: LatLng = { lat: 37.513059, lng: 127.059826 };
export const TILE_LAT = 0.00225;
export const TILE_LNG = 0.0028;
/** Cron이 거점마다 유지하는 반경 = 화면에서 고를 수 있는 최대 반경 */
export const PREWARM_RADIUS = 1000;
export const MIN_RADIUS = 100;
export const MAX_RADIUS = 1000;
export const RADIUS_STEP = 50;
export const DEFAULT_RADIUS = 500;
/** 100~1000m, 50m 단위 (응답 캐시 키가 몇 개뿐이게) */
export const isValidRadius = (r: number) =>
  Number.isInteger(r) && r >= MIN_RADIUS && r <= MAX_RADIUS && r % RADIUS_STEP === 0;

const HOUR = 3600_000;
export const TILE_TTL_MS = 7 * 24 * HOUR;
export const DETAIL_OK_TTL_MS = 3 * 24 * HOUR;
export const DETAIL_FAIL_TTL_MS = 6 * HOUR;
/** ok TTL에 id별로 더하는 0~24시간 지터 (한꺼번에 수집한 가게들이 같은 시각에 만료되지 않게) */
export const DETAIL_JITTER_MS = 24 * HOUR;
/** 상세 API가 403/429를 주면 이 시간 동안 모든 상세 호출을 멈춘다 */
export const PLACE_BLOCK_COOLDOWN_MS = 30 * 60_000;
/** R44: 같은 KST 날에 쿨다운이 이만큼 걸리면 상세 호출을 DETAIL_FREEZE_MS 동안 모두 멈춘다 (강등 모드) */
export const DETAIL_FREEZE_AFTER_BLOCKS = 3;
export const DETAIL_FREEZE_MS = 24 * HOUR;

/**
 * R12 places.list_json(목록 원소 조각)의 판. 조각은 `v{판}:` + JSON으로 저장하고, 목록은 지금 판 조각만 쓴다 (worker/present.ts).
 * 주의: 목록 원소 출력(toApiPlace 목록 모양, LIST_MENUS, shared/friendly.ts 판단 등)이 바뀌면 이 값을 올린다 —
 * 올리면 예전 조각은 목록에서 무시되고(열에서 만든다) Cron·관리자 백필이 새 판으로 다시 쓴다.
 */
export const LIST_JSON_VERSION = 1;

export const MAX_QUAD_DEPTH = 5;
export const KAKAO_PAGE_SIZE = 15;
export const KAKAO_MAX_RESULTS = 45;
