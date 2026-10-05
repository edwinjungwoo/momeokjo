/**
 * R44: 평점·메뉴가 얼마나 지난 정보인지. 강등 모드(frozen)이거나 가장 최근 상세가 4일보다 오래됐으면 지난 날 수,
 * 아니면 null(표시하지 않음). frozen이면 최소 1일로 보여준다 (갱신이 멈췄다는 뜻이라서).
 */
export const STALE_DETAIL_DAYS = 4;
const DAY = 24 * 3600_000;

export function detailAgeDays(frozenSince: number | null, newestAt: number | null, now: number): number | null {
  if (frozenSince !== null) {
    const asOf = newestAt ?? frozenSince;
    return Math.max(1, Math.floor((now - asOf) / DAY));
  }
  if (newestAt === null || now - newestAt <= STALE_DETAIL_DAYS * DAY) return null;
  return Math.floor((now - newestAt) / DAY);
}

export const freshnessText = (days: number) => `평점·메뉴는 ${days}일 전 기준이에요`;

/** R48: 상세를 가져온 시각 → "오늘 확인"(24시간 안, 미래 시각 포함) / "N일 전 확인". 펼친 결과 카드 맨 아래에 이것만 보여준다 */
export function checkedText(fetchedAt: number, now: number): string {
  const days = Math.floor((now - fetchedAt) / DAY);
  return days < 1 ? "오늘 확인" : `${days}일 전 확인`;
}
