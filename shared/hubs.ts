/**
 * R24 거점("Pin"). 거점을 늘리려면 이 배열에 한 줄만 더하면 된다.
 * R62: 새 거점은 `ready: false`(준비 중)로 더한다 — Cron 수집·보충, 관리자 warm·backfill·audit, 관리 화면은 모든 거점(HUBS)을,
 * 화면(거점 메뉴·첫 접속 질문·짧은 링크·공유 링크·설정 검증), 공개 목록 API, 이벤트 검증, 스냅샷은 공개 거점(PUBLIC_HUBS)만 쓴다.
 * 공개 순서: 수집 → 감사 Q1·Q2 통과 → `ready: true` 한 줄 → release (docs/deploy.md).
 * scripts/smoke.sh가 이 파일의 거점 줄을 sed로 읽는다 — 한 줄에 `id, name, lat, lng, ready` 순서를 지킨다.
 */
export type Hub = { id: string; name: string; lat: number; lng: number; ready: boolean };

export const HUBS: Hub[] = [
  { id: "bongeunsa", name: "봉은사역", lat: 37.514255, lng: 127.060234, ready: true },
  { id: "ddp", name: "동대문역사문화공원역", lat: 37.5651, lng: 127.00749, ready: true },
  // 신분당선·경강선 출구 사이
  { id: "pangyo", name: "판교역", lat: 37.394777, lng: 127.11159, ready: true },
  { id: "naebang", name: "내방역", lat: 37.487659, lng: 126.9936, ready: true },
  { id: "gwacheon", name: "정부과천청사역", lat: 37.426505, lng: 126.989868, ready: true },
  // 2026-10-06 추가 — 좌표는 카카오 로컬 키워드 검색(SW8 지하철역) 결과. R62: 수집·감사가 끝날 때까지 준비 중
  { id: "gangnam", name: "강남역", lat: 37.498086, lng: 127.028001, ready: false },
  { id: "yeouido", name: "여의도역", lat: 37.521775, lng: 126.924398, ready: false },
  { id: "gwanghwamun", name: "광화문역", lat: 37.571649, lng: 126.976424, ready: false },
];

/** R62: 사용자에게 보이는 거점 (ready만) */
export const PUBLIC_HUBS: Hub[] = HUBS.filter((h) => h.ready);

/** 기본 거점 — 공개 거점이어야 한다 (테스트로 고정) */
export const DEFAULT_HUB_ID = "bongeunsa";

/** 모든 거점(준비 중 포함)의 id인가 — 배경 작업·관리자용 */
export const isHubId = (id: string | null | undefined): id is string => HUBS.some((h) => h.id === id);

/** R62: 공개 거점의 id인가 — 화면·공개 API·이벤트용 (준비 중 거점은 모르는 거점처럼 false) */
export const isPublicHubId = (id: string | null | undefined): id is string => PUBLIC_HUBS.some((h) => h.id === id);

const defaultHub = (): Hub => PUBLIC_HUBS.find((h) => h.id === DEFAULT_HUB_ID) ?? PUBLIC_HUBS[0];

/** 모든 거점(준비 중 포함)에서 찾는다. 모르는 id나 빈 값이면 기본 거점 — 배경 작업·관리자용 */
export function hubById(id: string | null | undefined): Hub {
  return HUBS.find((h) => h.id === id) ?? defaultHub();
}

/** R62: 공개 거점에서 찾는다. 준비 중·모르는 id나 빈 값이면 기본 거점 — 화면용 */
export function publicHubById(id: string | null | undefined): Hub {
  return PUBLIC_HUBS.find((h) => h.id === id) ?? defaultHub();
}
