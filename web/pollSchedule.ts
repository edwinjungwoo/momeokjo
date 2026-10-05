import type { PlacesResponse } from "../shared/types";

/** R29: 목록을 다시 부르는 최대 횟수 (3 + 6 + 12 × 4 = 57초) */
export const MAX_POLLS = 6;
const FIRST_POLL_MS = 3000;
const MAX_POLL_MS = 12_000;

/** R29: polls번 다시 부른 뒤 다음 폴링까지 기다릴 시간. 3초 → 6초 → 12초(최대), MAX_POLLS번을 넘으면 null */
export function pollDelayMs(polls: number): number | null {
  if (polls >= MAX_POLLS) return null;
  return Math.min(FIRST_POLL_MS * 2 ** polls, MAX_POLL_MS);
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
