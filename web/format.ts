import { isOpenDuring } from "../shared/hours";
import type { Filters } from "../shared/recommend";
import type { ApiPlace, PlacesResponse } from "../shared/types";

export const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export function priceText(p: ApiPlace): string | null {
  const v = p.detail?.price ?? null;
  return v === null ? null : `${won(v)}대`;
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
    f.lunch === null ? `반경 ${f.radius}m` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export type Status = { text: string; tone: "info" | "warn"; busy: boolean };

/** R29: 리스트 위 상태 한 줄. data가 없을 때는 스켈레톤/에러 화면이 대신한다 */
export function statusOf(data: PlacesResponse | null, polling: boolean, error: boolean): Status | null {
  if (!data) return null;
  if (error) return { text: "최신 정보를 불러오지 못했어요", tone: "warn", busy: false };
  if (data.stale) return { text: "정보가 오래됐을 수 있어요", tone: "warn", busy: false };
  if (data.incompleteTiles > 0) {
    return polling
      ? { text: "주변 가게를 더 찾는 중이에요", tone: "info", busy: true }
      : { text: "주변 가게를 다 찾지 못했어요", tone: "warn", busy: false };
  }
  if (data.pending > 0) {
    return polling
      ? { text: `평점 정보 불러오는 중 (${data.pending}곳)`, tone: "info", busy: true }
      : { text: `${data.pending}곳은 아직 정보를 못 불러왔어요`, tone: "info", busy: false };
  }
  return null;
}
