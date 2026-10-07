import { detailAgeDays, freshnessText } from "../shared/freshness";
import { isOpenDuring, kstParts } from "../shared/hours";
import { isRefreshDay, refreshNoteText } from "../shared/refresh";
import type { Filters, Party } from "../shared/recommend";
import type { ApiPlace, Menu, PlacesResponse } from "../shared/types";

export const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export function priceText(p: ApiPlace): string | null {
  const v = p.detail?.price ?? null;
  return v === null ? null : `${won(v)}대`;
}

/** R28: 이 평점부터 강조색(별·숫자 오렌지, 지도 칩 오렌지). 그 아래는 칭찬처럼 보이지 않게 차분한 글자색 */
export const RATING_HIGH = 4;

export const ratingTone = (rating: number | null): "high" | "plain" => (rating !== null && rating >= RATING_HIGH ? "high" : "plain");

/** R22: 펼친 결과 카드에서 처음 보여주는 메뉴 수 (행동 줄 아래, 나머지는 "메뉴 N개 더 보기") */
export const MENU_PREVIEW = 5;

export function menuPreview(menus: Menu[], expanded: boolean): { shown: Menu[]; hidden: number } {
  if (expanded || menus.length <= MENU_PREVIEW) return { shown: menus, hidden: 0 };
  return { shown: menus.slice(0, MENU_PREVIEW), hidden: menus.length - MENU_PREVIEW };
}

export const walkText = (p: ApiPlace) => (p.walkMinutes === undefined ? null : `도보 ${p.walkMinutes}분`);

export type OpenState = { text: string; closed: boolean; kind: "open" | "closing" | "closed" | "unknown" };

/** 닫혔거나 30분 안에 닫히면(R17 기준으로 탈락) closed=true → 강조 */
export function openState(p: ApiPlace, now: Date): OpenState {
  const hours = p.detail?.hours ?? null;
  const openNow = isOpenDuring(hours, now, 0);
  if (openNow === null) return { text: "영업 정보 없음", closed: false, kind: "unknown" };
  if (!openNow) return { text: "지금 닫힘", closed: true, kind: "closed" };
  return isOpenDuring(hours, now, 30)
    ? { text: "영업 중", closed: false, kind: "open" }
    : { text: "곧 마감", closed: true, kind: "closing" };
}

/** "상세 조건" 접힘 상태에 보여줄 현재 값 한 줄 */
export function detailSummary(f: Filters): string {
  return [
    f.priceCap === "all" ? "예산 전체" : `${f.priceCap / 10000}만 이하`,
    f.minRating === 0 ? "평점 무관" : `평점 ${f.minRating.toFixed(1)}+`,
    f.openOnly ? "영업 중만" : null,
    f.includeBar ? "술집 포함" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type Status = { text: string; tone: "info" | "warn"; busy: boolean };

/** R29: 리스트 위 상태 한 줄. data가 없을 때는 스켈레톤/에러 화면이 대신한다. R44: 정보 기준 시점 */
export function statusOf(data: PlacesResponse | null, polling: boolean, error: boolean, now = Date.now()): Status | null {
  if (!data) return null;
  // 예전 응답(캐시)에는 R44 필드가 없을 수 있다
  const frozen = data.detailsFrozenSince ?? null;
  const age = detailAgeDays(frozen, data.detailsNewestAt ?? null, now);
  const ageStatus: Status | null = age === null ? null : { text: freshnessText(age), tone: "info", busy: false };
  if (error) return { text: "최신 정보를 불러오지 못했어요", tone: "warn", busy: false };
  if (data.stale) return { text: "정보가 오래됐을 수 있어요", tone: "warn", busy: false };
  if (data.incompleteTiles > 0) {
    return polling
      ? { text: "주변 가게를 더 찾는 중이에요", tone: "info", busy: true }
      : { text: "주변 가게를 다 찾지 못했어요", tone: "warn", busy: false };
  }
  // frozen이면 pending은 줄지 않으므로 기준 시점을 먼저 알린다
  if (frozen !== null && ageStatus) return ageStatus;
  if (data.pending > 0) {
    return polling
      ? { text: `평점 정보 불러오는 중 (${data.pending}곳)`, tone: "info", busy: true }
      : { text: `${data.pending}곳은 아직 정보를 못 불러왔어요`, tone: "info", busy: false };
  }
  return ageStatus;
}

/**
 * R63: 상태 줄 아래 조용한 한 줄 — "가게 정보 10월 9일(금) 업데이트 · 매주 금요일" (완료한 적이 없으면 "매주 금요일 업데이트").
 * 날짜는 서버가 주는 refreshedAt = 마지막으로 끝낸 주간 갱신의 시작(갱신 요일)이다 — 갱신 중에는 지난번 것.
 * 예전 기기 저장본에 필드가 없으면 거점 설정의 요일(hubRefreshDay)로, 날짜 없이
 */
export function refreshNote(data: PlacesResponse | null, hubRefreshDay: number): string | null {
  if (!data) return null;
  const day = isRefreshDay(data.refreshDay) ? data.refreshDay : hubRefreshDay;
  return refreshNoteText(data.refreshedAt ?? null, day);
}

const hhmm = (m: number) => {
  const t = m % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** 펼친 카드의 "오늘 11:00~15:00, 17:00~21:00" / "오늘 휴무". 정보가 없으면 null */
export function todayHoursText(p: ApiPlace, now: Date): string | null {
  const day = p.detail?.hours?.[kstParts(now).dow];
  if (!day) return null;
  if (day === "closed") return "오늘 휴무";
  if (day.length === 0) return null;
  return `오늘 ${day.map(([a, b]) => `${hhmm(a)}~${hhmm(b)}`).join(", ")}`;
}

/** R49: 전화번호 → tel: 링크 (숫자와 +만 남긴다). 숫자가 없으면 null */
export function telHref(phone: string | null | undefined): string | null {
  const v = (phone ?? "").replace(/[^0-9+]/g, "");
  return /\d/.test(v) ? `tel:${v}` : null;
}

/** R49: 4명+이면 펼친 결과 카드의 첫 행동을 "전화로 자리 확인"으로 (전화번호는 R13 단건에만 있다) */
export const callFirst = (p: ApiPlace, party: Party): string | null => (party >= 4 ? telHref(p.phone) : null);
