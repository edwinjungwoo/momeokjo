const KST_OFFSET_MS = 9 * 60 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;

/** epoch ms → KST 날짜(yyyy-mm-dd)와 시(0–23). 한국은 서머타임이 없어 UTC+9 고정이다 */
export function kstDayHour(ts: number): { day: string; hour: number } {
  const d = new Date(ts + KST_OFFSET_MS);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

export const kstDay = (ts: number) => kstDayHour(ts).day;

/** epoch ms → UTC 날짜(yyyy-mm-dd). D1 무료 한도는 UTC 자정(KST 09:00)에 초기화된다 (R38) */
export const utcDay = (ts: number) => new Date(ts).toISOString().slice(0, 10);
