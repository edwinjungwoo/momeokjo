/**
 * R24 거점("Pin"). 거점을 늘리려면 이 배열에 한 줄만 더하면 된다.
 * R62: 새 거점은 `ready: false`(준비 중)로 더한다 — Cron 수집·보충, 관리자 warm·backfill·audit, 관리 화면은 모든 거점(HUBS)을,
 * 화면(거점 메뉴·첫 접속 질문·짧은 링크·공유 링크·설정 검증), 공개 목록 API, 이벤트 검증, 스냅샷은 공개 거점(PUBLIC_HUBS)만 쓴다.
 * 공개 순서: 수집 → 감사 Q1·Q2 통과 → `ready: true` 한 줄 → release (docs/deploy.md).
 * scripts/smoke.sh가 이 파일의 거점 줄을 sed로 읽는다 — 한 줄에 `id, name, lat, lng, ready, refreshDay` 순서를 지킨다.
 * R63: `refreshDay`는 그 거점 가게 정보를 다시 가져오는 요일(KST, 0=일 ~ 6=토)이다. 그날 00:00 KST부터 그 시각 전에 가져온
 * 가게가 갱신 대상이 되고(다 못 하면 다음 날로 이어진다), 격자 재수집도 같은 시작에 맞춘다 (worker/refreshSchedule.ts).
 * 새 거점은 거점이 적은 요일에 넣는다 — 한 요일에 큰 거점이 몰리면 그 주 갱신이 늦어진다. 일요일(0)은 비워 둔 여유 날이다.
 * 지금: 월 봉은사·선정릉·선릉·삼성 · 화 동대문 · 수 판교·내방 · 목 정부과천청사·광화문 · 금 강남·역삼 · 토 여의도.
 */
export type Hub = { id: string; name: string; lat: number; lng: number; ready: boolean; refreshDay: number };

export const HUBS: Hub[] = [
  { id: "bongeunsa", name: "봉은사역", lat: 37.514255, lng: 127.060234, ready: true, refreshDay: 1 },
  { id: "ddp", name: "동대문역사문화공원역", lat: 37.5651, lng: 127.00749, ready: true, refreshDay: 2 },
  // 신분당선·경강선 출구 사이
  { id: "pangyo", name: "판교역", lat: 37.394777, lng: 127.11159, ready: true, refreshDay: 3 },
  { id: "naebang", name: "내방역", lat: 37.487659, lng: 126.9936, ready: true, refreshDay: 3 },
  { id: "gwacheon", name: "정부과천청사역", lat: 37.426505, lng: 126.989868, ready: true, refreshDay: 4 },
  // 2026-10-06 추가 — 좌표는 카카오 로컬 키워드 검색(SW8 지하철역) 결과. R62: 수집·감사(Q1·Q2)를 마치고 2026-10-08 공개
  { id: "gangnam", name: "강남역", lat: 37.498086, lng: 127.028001, ready: true, refreshDay: 5 },
  { id: "yeouido", name: "여의도역", lat: 37.521775, lng: 126.924398, ready: true, refreshDay: 6 },
  { id: "gwanghwamun", name: "광화문역", lat: 37.571649, lng: 126.976424, ready: true, refreshDay: 4 },
  // 2026-10-08 추가 — 좌표는 카카오 로컬 키워드 검색(SW8, 역삼은 2호선·선정릉은 9호선 출구). R62: 수집·감사를 마치고 2026-10-09 공개.
  // 갱신 요일은 많이 겹치는 거점과 같은 날 — 겹친 칸·가게는 그날 한 번만 다시 가져온다 (역삼 ↔ 강남 금, 선정릉 ↔ 봉은사 월)
  { id: "yeoksam", name: "역삼역", lat: 37.500674, lng: 127.036469, ready: true, refreshDay: 5 },
  { id: "seonjeongneung", name: "선정릉역", lat: 37.510324, lng: 127.044015, ready: true, refreshDay: 1 },
  // 2026-10-09 추가·공개 (좌표는 카카오 로컬 SW8, 2호선 출구). 테헤란로 빈 곳 — 갱신은 많이 겹치는 봉은사·선정릉과 같은 월요일
  { id: "seolleung", name: "선릉역", lat: 37.504497, lng: 127.048963, ready: true, refreshDay: 1 },
  { id: "samseong", name: "삼성역", lat: 37.508823, lng: 127.063023, ready: true, refreshDay: 1 },
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
