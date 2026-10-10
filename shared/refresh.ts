import { DAY_MS, KST_OFFSET_MS } from "./kst";

/**
 * R63 거점별 주 1회 갱신. 거점마다 `refreshDay`(shared/hubs.ts, KST 요일 0=일 ~ 6=토)가 있고,
 * 그 요일 00:00 KST가 "갱신 시작"이다. 시작 전에 수집한 격자와 due_after(R66 — 가게마다 1·2·4주 주기)가 시작 전인 상세가
 * 갱신 대상이다 (worker/refreshSchedule.ts). 화면은 마지막으로 다 갱신한 시각(refreshedAt)과 요일을 조용히 보여준다.
 */
export const REFRESH_DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

export const isRefreshDay = (d: unknown): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6;

/** 지금(now) 이하인 가장 최근의 `day`요일 00:00 KST (epoch ms). 한국은 서머타임이 없어 UTC+9 고정이다 */
export function refreshStart(day: number, now: number): number {
  const todayStart = Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS; // KST 자정 (+9시간 옮긴 시계)
  const dow = new Date(todayStart).getUTCDay();
  return todayStart - ((dow - day + 7) % 7) * DAY_MS - KST_OFFSET_MS;
}

/**
 * "가게 정보 10월 6일(월) 확인 · 새 가게는 매주 월요일" / 한 번도 다 갱신하지 않았으면 "새 가게는 매주 월요일 확인해요".
 * R66: 가게 정보(상세)는 가게마다 1·2·4주 주기로 바뀌는 만큼만 다시 가져와서 "매주 업데이트"라고 하지 않는다 — 매주 그 요일에
 * 하는 것은 격자 재수집(새 가게·없어진 가게)과 그 주에 대상인 가게의 확인이다. 날짜는 끝낸 갱신의 시작(갱신 요일)이다
 */
export function refreshNoteText(refreshedAt: number | null, day: number): string {
  const weekly = `새 가게는 매주 ${REFRESH_DAY_NAMES[day] ?? ""}요일`;
  if (refreshedAt === null) return `${weekly} 확인해요`;
  const d = new Date(refreshedAt + KST_OFFSET_MS);
  return `가게 정보 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${REFRESH_DAY_NAMES[d.getUTCDay()]}) 확인 · ${weekly}`;
}
