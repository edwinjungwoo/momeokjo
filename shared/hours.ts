import type { Hours, Interval } from "./types";

export type RawDay = {
  day_of_the_week_desc?: string;
  on_days?: { start_end_time_desc?: string; break_times_desc?: string[] };
  off_days_desc?: string;
};

const DOW: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
const RANGE = /^(\d{1,2}):(\d{2})\s*~\s*(\d{1,2}):(\d{2})/;
const DAY_MIN = 1440;

function parseRange(text: string): Interval | null {
  const m = RANGE.exec(text.trim());
  if (!m) return null;
  const open = Number(m[1]) * 60 + Number(m[2]);
  let close = Number(m[3]) * 60 + Number(m[4]);
  if (close <= open) close += DAY_MIN;
  return [open, close];
}

function subtract([a, b]: Interval, [c, d]: Interval): Interval[] {
  if (d <= a || c >= b) return [[a, b]];
  const out: Interval[] = [];
  if (c > a) out.push([a, c]);
  if (d < b) out.push([d, b]);
  return out;
}

export function parseHours(days: RawDay[] | null | undefined): Hours | null {
  if (!days || days.length === 0) return null;
  const out: Hours = {};
  for (const day of days) {
    const dow = DOW[(day.day_of_the_week_desc ?? "").trim().charAt(0)];
    if (dow === undefined) return null;
    if (day.off_days_desc) {
      out[dow] = "closed";
      continue;
    }
    const mainText = day.on_days?.start_end_time_desc;
    const main = mainText ? parseRange(mainText) : null;
    if (!main) return null;
    let segments: Interval[] = [main];
    for (const text of day.on_days?.break_times_desc ?? []) {
      let br = parseRange(text);
      if (!br) return null;
      if (br[0] < main[0]) br = [br[0] + DAY_MIN, br[1] + DAY_MIN];
      const cut = br;
      segments = segments.flatMap((s) => subtract(s, cut));
    }
    out[dow] = segments;
  }
  return out;
}

export function kstParts(at: Date): { dow: number; minute: number } {
  const t = new Date(at.getTime() + 9 * 3600_000);
  return { dow: t.getUTCDay(), minute: t.getUTCHours() * 60 + t.getUTCMinutes() };
}

const covers = (segs: Interval[] | "closed" | undefined, start: number, end: number) =>
  Array.isArray(segs) && segs.some(([a, b]) => a <= start && end <= b);

export function isOpenDuring(hours: Hours | null, at: Date, durationMin = 30): boolean | null {
  if (!hours) return null;
  const { dow, minute } = kstParts(at);
  const today = hours[dow];
  const prev = hours[(dow + 6) % 7];
  if (today === undefined && prev === undefined) return null;
  return covers(today, minute, minute + durationMin) || covers(prev, minute + DAY_MIN, minute + DAY_MIN + durationMin);
}
