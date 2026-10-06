// R57 관리 화면 숫자·시간 표기 (KST, 한국어). 화면 전용 — 서버는 부르지 않는다.
import { REFRESH_DAY_NAMES } from "../../shared/refresh";

const KST = 9 * 3600_000;

/** 1,234 / 1.2만 / 12만 (1만 이상은 만 단위, 소수 한 자리) */
export function num(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 100_000_000) return `${trim((v / 100_000_000).toFixed(1))}억`;
  if (a >= 10_000) return `${trim((v / 10_000).toFixed(a >= 100_000 ? 0 : 1))}만`;
  if (!Number.isInteger(v)) return v.toFixed(1);
  return v.toLocaleString("ko-KR");
}
const trim = (s: string) => s.replace(/\.0$/, "");

/** 0.123 → 12% (1% 미만은 소수 한 자리) */
export function pct(v: number | null | undefined, digits?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const p = v * 100;
  const d = digits ?? (p !== 0 && Math.abs(p) < 1 ? 1 : 0);
  return `${p.toFixed(d)}%`;
}

/** 증감률 → "+12%" / "−5%" (null이면 빈 문자열) */
export function delta(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "";
  const p = Math.round(v * 100);
  if (p === 0) return "±0%";
  return `${p > 0 ? "+" : "−"}${Math.abs(p)}%`;
}

/** 초 → "25초" / "3분 10초" / "1시간 5분" */
export function duration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "–";
  const s = Math.round(sec);
  if (s < 60) return `${s}초`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}분 ${r}초` : `${m}분`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** epoch ms → KST "1/15 13:05" */
export function kstTime(ms: number | null | undefined, withDate = true): string {
  if (!ms) return "–";
  const d = new Date(ms + KST);
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withDate ? `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hm}` : hm;
}
/** "2027-01-15" → "1/15" */
export const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"];
export const weekdayLabel = (i: number) => WEEKDAYS[i];
/** "2027-01-15" → "1/15(금)" */
export function dayLabel(day: string): string {
  const w = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return `${shortDay(day)}(${WEEKDAYS[w]})`;
}

/** 지금부터 ms까지 남은 시간 → "3시간 12분" */
export function until(ms: number, now: number): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  if (s < 60) return `${s}초`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}시간 ${m}분` : `${m}분`;
}
/** ms 전 → "방금" / "3분 전" / "2시간 전" / "4일 전" */
export function ago(ms: number | null | undefined, now: number): string {
  if (!ms) return "–";
  const s = Math.round((now - ms) / 1000);
  if (s < 45) return "방금";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}분 전`;
  if (s < 86_400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86_400)}일 전`;
}

/** R63 운영 거점 표: 갱신 요일과 이번 시작 날짜 "월 10/5" (시작을 모르면 요일만) */
export function refreshStartLabel(day: number, start: number): string {
  const name = REFRESH_DAY_NAMES[day] ?? "–";
  return Number.isFinite(start) ? `${name} ${kstTime(start).split(" ")[0]}` : name;
}

/** R63: 이번 갱신을 끝냈으면 완료 시각, 아니면 "진행 중"(지난 완료가 있으면 같이) */
export function refreshDoneLabel(h: { refreshStart: number; refreshedStart: number | null; refreshedAt: number | null }): {
  done: boolean; text: string;
} {
  if (h.refreshedAt !== null && h.refreshedStart === h.refreshStart) return { done: true, text: kstTime(h.refreshedAt) };
  return { done: false, text: h.refreshedAt === null ? "진행 중" : `진행 중 · 지난 완료 ${kstTime(h.refreshedAt)}` };
}
