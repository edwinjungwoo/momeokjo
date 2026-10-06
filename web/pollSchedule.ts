import type { PlacesResponse } from "../shared/types";

/** R29: 목록을 다시 부르는 최대 횟수 (10 + 12 + 15 × 3 = 67초) */
export const MAX_POLLS = 5;
/**
 * R29: 다시 부르기 전에 기다릴 시간. pending이 남은 목록은 엣지에 10초 캐시되므로(worker/app.ts PLACES_PENDING_CACHE_MS)
 * 첫 폴링은 10초 뒤 — 더 일찍 부르면 같은 캐시 응답만 받는다.
 */
const POLL_DELAYS_MS = [10_000, 12_000, 15_000];

/** R29: polls번 다시 부른 뒤 다음 폴링까지 기다릴 시간. 10초 → 12초 → 15초(이후 15초), MAX_POLLS번을 넘으면 null */
export function pollDelayMs(polls: number): number | null {
  if (polls >= MAX_POLLS) return null;
  return POLL_DELAYS_MS[Math.min(polls, POLL_DELAYS_MS.length - 1)];
}

/**
 * R29: 이 응답 뒤에 다시 부를까. 수집 중 격자가 남았거나 pending이 남았을 때만.
 * R10/R44: 상세 가져오기가 멈췄으면(쿨다운·frozen) pending은 줄지 않으므로 그것 때문에는 부르지 않는다.
 * 예전 응답(기기 저장본)에는 detailsPaused가 없을 수 있어서 frozen 시각도 같이 본다.
 */
export function shouldPoll(data: PlacesResponse): boolean {
  if (data.incompleteTiles > 0) return true;
  const paused = (data.detailsPaused ?? false) || (data.detailsFrozenSince ?? null) !== null;
  return data.pending > 0 && !paused;
}

/** R29: 거점을 바꿀 때 목록을 부르기 전 디바운스 */
export const HUB_CHANGE_DEBOUNCE_MS = 250;

/**
 * R29/R45/R61: 목록을 부르기 전에 기다릴 시간. 꺼져 있으면(첫 접속 거점 질문 중) null — 부르지 않는다.
 * 처음 부를 때(lastHub null — 질문에서 고른 직후 포함)와 같은 거점 다시 시도는 바로, 거점을 바꿀 때만 디바운스.
 */
export function loadDelayMs(lastHub: string | null, hubId: string, enabled: boolean): number | null {
  if (!enabled) return null;
  return lastHub !== null && lastHub !== hubId ? HUB_CHANGE_DEBOUNCE_MS : 0;
}
