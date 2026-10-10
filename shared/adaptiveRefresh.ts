import { groupFriendly, soloFriendly } from "./friendly";
import type { Interval, PlaceDetail, PlaceSummary } from "./types";

/**
 * R66 적응형 상세 갱신 (바뀌는 만큼만). 가게마다 갱신 주기 interval_weeks(1·2·4주)를 두고, 상세를 저장할 때 표시 정보 지문(fp)이
 * 지난번과 같으면 주기를 두 배(최대 4주), 다르거나 처음이면 1주로 한다. 거점 주간 갱신(R63)의 대상 판단은 fetched_at 대신
 * due_after = fetched_at + (간격 − 1) × 7일을 본다 — 간격은 1~주기 사이에서 가게 id 위상으로 정해(refreshGapWeeks) 주기 2·4주
 * 가게들이 한 주에 몰리지 않고, 그 뒤로는 주기마다 돌아온다. 실패(R9)는 주기·지문을 바꾸지 않는다.
 * 저장 SQL(worker/repo.ts)이 이전 행의 지문·주기로 새 주기를 정한다. 이 파일은 지문과 계산식만 둔다 (Worker·테스트가 같이 쓴다)
 */
export const WEEK_MS = 7 * 24 * 3600_000;
export const INTERVAL_WEEKS = [1, 2, 4] as const;
export const MAX_INTERVAL_WEEKS = 4;
/**
 * R66 볼 때 신선하게: 단건(R13)으로 연 가게의 상세가 이보다 오래됐으면 응답은 저장된 그대로 주고 뒤에서 한 곳만 다시 가져온다
 * (stale-while-revalidate). 다시 가져온 가게는 주기 1주로 둔다 — 사람들이 여는 가게는 매주 본다
 */
export const SHOW_REFRESH_AFTER_MS = 7 * 24 * 3600_000;

/** 다음 갱신 기준 시각: 가져온 시각 + (간격 − 1) × 7일 (간격 1이면 가져온 시각 그대로 — R63과 같다). 간격은 refreshGapWeeks */
export const dueAfterOf = (fetchedAt: number, gapWeeks: number): number => fetchedAt + (gapWeeks - 1) * WEEK_MS;

/** id로 정해지는 32비트 해시 (FNV-1a 32비트 + murmur3 마무리 섞기 — 연속된 id도 고르게 흩어진다). R9 지터(detailJitterMs)와 같은 해시 */
export function idHash(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** epoch 주 번호 (1970-01-01부터 7일씩 — 기준은 아무 고정값이면 된다) */
export const weekIndex = (t: number): number => Math.floor(t / WEEK_MS);

/**
 * R66 Fix 1 (위상 흩기): 주기 n(1·2·4)으로 저장할 때 다음 갱신까지의 간격(주). 같은 때 2·4주가 된 가게들이 한 주에 몰려 돌아오지
 * 않게 가게마다 위상 phase = idHash(id) mod n을 두고, (가져온 주 + 간격) ≡ phase (mod n)인 가장 작은 간격 ≥ 1을 고른다
 * (1 ≤ 간격 ≤ n). 다음 갱신은 대략 간격 주 뒤라 그 뒤로는 정확히 n주마다, 같은 위상으로 돈다. 주기 1은 언제나 1
 */
export function refreshGapWeeks(id: string, fetchedAt: number, intervalWeeks: number): number {
  const n = intervalWeeks;
  if (n <= 1) return 1;
  const phase = idHash(id) % n;
  return ((((phase - weekIndex(fetchedAt) - 1) % n) + n) % n) + 1;
}

/** 영업시간을 요일 0~6 순서, 구간은 여는 시각 순으로 (키 순서·구간 순서와 상관없이 같은 값) */
function hoursKey(hours: PlaceDetail["hours"]): unknown {
  if (!hours) return null;
  return [0, 1, 2, 3, 4, 5, 6].map((day) => {
    const v = hours[day] as Interval[] | "closed" | undefined;
    if (v === undefined || v === "closed") return v ?? null;
    return [...v].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  });
}

/**
 * 화면에 보이는 상세의 지문 (리뷰 수·사진은 뺀다 — 리뷰 수만 바뀐 것은 바뀐 것으로 치지 않는다): 이름, 카테고리, 평점(0.1 단위),
 * 대표 가격, 영업시간, 메뉴(이름·가격, 순서대로), 전화, 예약 가능, 강점, 혼밥·단체 판단(태그는 응답에 싣지 않고 이 판단만 보인다).
 * 정해진 순서의 JSON 배열을 FNV-1a 32비트로 — 8자리 16진수
 */
export function detailFingerprint(s: Pick<PlaceSummary, "name" | "categoryName" | "phone">, d: PlaceDetail): string {
  const canonical = JSON.stringify([
    s.name,
    s.categoryName,
    d.rating === null ? null : Math.round(d.rating * 10) / 10,
    d.price,
    hoursKey(d.hours),
    d.menus.map((m) => [m.name, m.price]),
    s.phone,
    d.bookable,
    d.strengths,
    soloFriendly(s.categoryName, d.tags),
    groupFriendly(d.tags),
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) h = Math.imul(h ^ canonical.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 이번 저장이 지난번과 비교해 어떤가 (R66 관리 화면 계수): 이전 지문 없음 first, 같음 same, 다름 changed */
export type FpKind = "first" | "same" | "changed";
export const fpKind = (prev: string | null | undefined, next: string): FpKind =>
  prev === null || prev === undefined ? "first" : prev === next ? "same" : "changed";
