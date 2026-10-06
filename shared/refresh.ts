import { DAY_MS, KST_OFFSET_MS } from "./kst";

/**
 * R63 거점별 주 1회 갱신. 거점마다 `refreshDay`(shared/hubs.ts, KST 요일 0=일 ~ 6=토)가 있고,
 * 그 요일 00:00 KST가 "갱신 시작"이다. 시작 전에 가져온 상세·수집한 격자가 갱신 대상이다 (worker/refreshSchedule.ts).
 * 화면은 마지막으로 다 갱신한 시각(refreshedAt)과 요일을 조용히 보여준다.
 */
export const REFRESH_DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

export const isRefreshDay = (d: unknown): d is number => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6;

/** 지금(now) 이하인 가장 최근의 `day`요일 00:00 KST (epoch ms). 한국은 서머타임이 없어 UTC+9 고정이다 */
export function refreshStart(day: number, now: number): number {
  const todayStart = Math.floor((now + KST_OFFSET_MS) / DAY_MS) * DAY_MS; // KST 자정 (+9시간 옮긴 시계)
  const dow = new Date(todayStart).getUTCDay();
  return todayStart - ((dow - day + 7) % 7) * DAY_MS - KST_OFFSET_MS;
}

/** "가게 정보 10월 6일(월) 업데이트 · 매주 월요일" / 한 번도 다 갱신하지 않았으면 "매주 월요일 업데이트" */
export function refreshNoteText(refreshedAt: number | null, day: number): string {
  const weekly = `매주 ${REFRESH_DAY_NAMES[day] ?? ""}요일`;
  if (refreshedAt === null) return `${weekly} 업데이트`;
  const d = new Date(refreshedAt + KST_OFFSET_MS);
  return `가게 정보 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일(${REFRESH_DAY_NAMES[d.getUTCDay()]}) 업데이트 · ${weekly}`;
}
