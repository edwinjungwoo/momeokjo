// R45: 화면(web/analytics)이 쓰는 이벤트 상수·세션 함수. zod가 없어서 화면 번들에 zod가 딸려 오지 않는다.
// 서버 검증 스키마는 shared/events.ts에 있고, 거기서 이 파일을 다시 내보낸다.

/**
 * R35 익명 사용 이벤트. 로그인 없이 브라우저마다 무작위 id(anon)와 탭 세션 id(session)만 보낸다.
 * IP, User-Agent, 정확한 위치, 자유 입력 글자는 받지도 저장하지도 않는다. 90일 뒤 지운다.
 */
export const EVENT_TYPES = [
  "app_open", // 세션마다 한 번
  "draw", // 첫 뽑기 (결과가 없을 때). R39 자동 뽑기는 props.auto = true
  "redraw", // 결과가 떠 있는 상태에서 다시 뽑기
  "share", // 공유·복사 성공 (picks = 공유한 곳). R47 "여기로 가자고 공유"는 props.confirm = true
  "open_kakao", // 카카오맵 열기 (rank = 결과 3곳 중 몇 번째인지)
  "select_place", // 목록·지도 핀에서 한 곳을 엶
  "hub_change", // 거점 칩으로 거점을 바꿈. R61 첫 접속 질문에서 고른 것은 props.onboarding = true
  "filter_change", // 1초 디바운스, 바뀐 뒤의 필터 스냅숏
  "empty_result", // 필터를 바꾼 뒤 후보가 0곳이 됨
  "expand_card", // 결과 카드를 펼침 (rank)
  "exclude_place", // "다음부터 안 보기"
  "undo_exclude", // "되돌리기"
  "share_open", // 받은 공유 링크(t=)를 엶 (picks)
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const ANON_KEY = "mmj:anon:v1";
export const SESSION_KEY = "mmj:session:v1";
export const SESSION_IDLE_MS = 30 * 60_000;
export const MAX_EVENTS_PER_REQUEST = 20;
export const MAX_EVENT_BODY_BYTES = 8 * 1024;
/** 클라이언트 시각이 서버 시각과 이만큼 넘게 다르면 서버 시각을 쓴다 */
export const TS_SKEW_MS = 10 * 60_000;
export const EVENT_RETENTION_DAYS = 90;

export const UUIDISH = /^[0-9a-f-]{36}$/;

export const clampTs = (ts: number, now: number) => (Math.abs(ts - now) <= TS_SKEW_MS ? Math.round(ts) : now);

/** 탭 세션: 저장된 {id, at}이 30분 안이면 이어 쓰고, 아니면 새로 만든다. stored는 다시 저장할 값 */
export function nextSession(
  raw: string | null, now: number, newId: () => string,
): { id: string; isNew: boolean; stored: string } {
  let prev: { id?: unknown; at?: unknown } | null = null;
  try {
    prev = raw ? JSON.parse(raw) : null;
  } catch {
    prev = null;
  }
  const alive =
    prev !== null && typeof prev.id === "string" && UUIDISH.test(prev.id) && typeof prev.at === "number" &&
    now - prev.at <= SESSION_IDLE_MS && now >= prev.at - TS_SKEW_MS;
  const id = alive ? (prev!.id as string) : newId();
  return { id, isNew: !alive, stored: JSON.stringify({ id, at: now }) };
}
