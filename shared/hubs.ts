/**
 * R24 거점("Pin"). 거점을 늘리려면 이 배열에 한 줄만 더하면 된다.
 * R62·R68: 새 거점은 `ready: false`(공개 후보)로 더한다 — Cron 수집·보충, 관리자 warm·backfill·audit, 관리 화면은 모든 거점(HUBS)을,
 * 화면(거점 메뉴·첫 접속 질문·짧은 링크·공유 링크·설정 검증), 공개 목록 API, 이벤트 검증, 스냅샷은 공개 거점(publicHubs())만 쓴다.
 * R68: 공개 거점 = `ready: true`(언제나 공개) ∪ 시스템이 공개로 기록한 후보(D1 meta `hub_public:{id}`). 본 Cron이 감사(Q1·Q2)를 통과한
 * 후보를 스스로 공개하고(worker/hubPublish.ts), 관리 화면에서 손으로 공개·공개 취소도 한다 — 배포가 필요 없다. 서버는 meta를 읽어
 * (worker/publicHubs.ts, 격리 공간마다 5분 캐시), 화면은 GET /api/hubs를 읽어(web/publicHubs.ts) setPublishedHubIds로 알려 준다.
 * 모르는 동안(첫 읽기 전·실패)은 ready만 공개다.
 * scripts/smoke.sh가 이 파일의 거점 줄을 sed로 읽는다 — 한 줄에 `id, name, lat, lng, ready, refreshDay` 순서를 지킨다.
 * R63: `refreshDay`는 그 거점 가게 정보를 다시 가져오는 요일(KST, 0=일 ~ 6=토)이다. 그날 00:00 KST부터 그 시각 전에 가져온
 * 가게가 갱신 대상이 되고(다 못 하면 다음 날로 이어진다), 격자 재수집도 같은 시작에 맞춘다 (worker/refreshSchedule.ts).
 * 새 거점은 거점이 적은 요일에 넣는다 — 한 요일에 큰 거점이 몰리면 그 주 갱신이 늦어진다. 일요일(0)은 비워 둔 여유 날이다.
 * 지금: 월 봉은사·선정릉·선릉·삼성 · 화 동대문 · 수 판교·내방 · 목 정부과천청사·광화문·시청·을지로입구 · 금 강남·역삼 · 토 여의도.
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
  // 2026-10-09 추가, 2026-10-10 공개 (좌표는 카카오 로컬 SW8). 도심 사무실 — 갱신은 많이 겹치는 광화문과 같은 목요일
  { id: "cityhall", name: "시청역", lat: 37.565345, lng: 126.977198, ready: true, refreshDay: 4 },
  { id: "euljiro1ga", name: "을지로입구역", lat: 37.566036, lng: 126.982195, ready: true, refreshDay: 4 },
];

/** R62·R68: 언제나 공개인 거점 (ready: true) — 런타임 공개 목록을 모를 때(첫 읽기 전·실패)의 공개 거점 */
export const READY_HUBS: Hub[] = HUBS.filter((h) => h.ready);

/** 기본 거점 — 언제나 공개(ready)여야 한다 (테스트로 고정) */
export const DEFAULT_HUB_ID = "bongeunsa";

/** 모든 거점(공개 후보 포함)의 id인가 — 배경 작업·관리자용 */
export const isHubId = (id: string | null | undefined): id is string => HUBS.some((h) => h.id === id);

/** R68: 공개 후보(`ready: false`)의 id인가 — 공개됐는지는 따로 (isPublicHubId) */
export const isCandidateHubId = (id: string | null | undefined): id is string => HUBS.some((h) => h.id === id && !h.ready);

/** R68: 공개 후보가 하나라도 있나 — 없으면 공개 거점은 언제나 ready뿐이라 런타임 목록을 읽을 필요가 없다 */
export const hasCandidateHubs = (): boolean => HUBS.some((h) => !h.ready);

// R68: 런타임에 공개로 알려진 후보 id와 그것으로 만든 공개 거점 목록 (서버는 격리 공간, 화면은 탭마다 하나)
let published: ReadonlySet<string> = new Set();
let view: readonly Hub[] = READY_HUBS;

/**
 * R68: 공개된 후보 id를 알려 준다 (전부 바꾼다). 후보가 아닌 id(모르는 id·ready 거점)는 버린다.
 * 서버(worker/publicHubs.ts)는 meta에서, 화면(web/publicHubs.ts)은 GET /api/hubs에서 읽어 부른다
 */
export function setPublishedHubIds(ids: Iterable<string>): void {
  published = new Set([...ids].filter((id) => isCandidateHubId(id)));
  view = HUBS.filter((h) => h.ready || published.has(h.id));
}

/** R68: 지금 공개로 알려진 후보 id (HUBS 순서) */
export const publishedHubIds = (): string[] => HUBS.filter((h) => !h.ready && published.has(h.id)).map((h) => h.id);

/** R62·R68: 사용자에게 보이는 거점 — ready ∪ 공개된 후보 (HUBS 순서) */
export const publicHubs = (): readonly Hub[] => view;

/** R62·R68: 공개 거점의 id인가 — 화면·공개 API·이벤트용 (공개 전 후보는 모르는 거점처럼 false) */
export const isPublicHubId = (id: string | null | undefined): id is string => view.some((h) => h.id === id);

const defaultHub = (): Hub => READY_HUBS.find((h) => h.id === DEFAULT_HUB_ID) ?? READY_HUBS[0];

/** 모든 거점(공개 후보 포함)에서 찾는다. 모르는 id나 빈 값이면 기본 거점 — 배경 작업·관리자용 */
export function hubById(id: string | null | undefined): Hub {
  return HUBS.find((h) => h.id === id) ?? defaultHub();
}

/** R62·R68: 공개 거점에서 찾는다. 공개 전 후보·모르는 id나 빈 값이면 기본 거점 — 화면용 */
export function publicHubById(id: string | null | undefined): Hub {
  return view.find((h) => h.id === id) ?? defaultHub();
}
