const KST_OFFSET_MS = 9 * 60 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;

/** epoch ms → KST 날짜(yyyy-mm-dd)와 시(0–23). 한국은 서머타임이 없어 UTC+9 고정이다 */
export function kstDayHour(ts: number): { day: string; hour: number } {
  const d = new Date(ts + KST_OFFSET_MS);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

export const kstDay = (ts: number) => kstDayHour(ts).day;
