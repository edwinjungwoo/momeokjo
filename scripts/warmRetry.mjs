// warm.mjs·backfill.mjs가 429를 받았을 때 할 일 (R36, R38). node와 테스트(workerd) 둘 다에서 돌도록 의존성 없음
import { on5xx } from "./backfillGuard.mjs";

export const RATE_LIMIT_WAIT_MS = 30_000;
export const RATE_LIMIT_RETRIES = 3;

/**
 * @param {string} bodyText 429 응답 본문
 * @param {number} retries 이번 요청에서 이미 rate_limited로 다시 한 횟수
 * @returns {{ action: "retry", waitMs: number } | { action: "stop", reason: "rate_limited" | "read_budget" | "write_budget" | "unknown" }}
 */
export function on429(bodyText, retries) {
  let error;
  try {
    error = JSON.parse(bodyText)?.error;
  } catch {
    error = undefined;
  }
  // R36: 관리자 전용 제한(ADMIN_LIMITER, 분당 120회)에 걸렸다 — 창이 지나면 풀린다
  if (error === "rate_limited") {
    return retries < RATE_LIMIT_RETRIES ? { action: "retry", waitMs: RATE_LIMIT_WAIT_MS } : { action: "stop", reason: "rate_limited" };
  }
  // R38: 오늘 D1 읽기가 소프트 한도를 넘었다. 다시 두드리면 읽기만 더 쓴다
  if (error === "read_budget") return { action: "stop", reason: "read_budget" };
  // R38: 오늘 D1 쓰기가 소프트 한도를 넘었다 (backfill)
  if (error === "write_budget") return { action: "stop", reason: "write_budget" };
  return { action: "stop", reason: "unknown" };
}

/** Task 34: warm 후보 고르기가 쪽 상한에서 멈췄는데(truncated) 아무것도 못 한 응답이 이만큼 이어지면 warm.mjs가 멈춘다 */
export const TRUNCATED_STOP_AFTER = 3;

/**
 * @param {{ truncated?: boolean, enriched?: number, failed?: number, incompleteTiles?: number }} r warm 응답
 * @param {number} streak 지금까지 이어진 횟수
 * @returns {number} 이 응답 뒤의 횟수 (하나라도 했거나, 아직 격자를 모으는 중이거나, truncated가 아니면 0)
 */
export function nextTruncatedStreak(r, streak) {
  return r.truncated === true && !r.enriched && !r.failed && !r.incompleteTiles ? streak + 1 : 0;
}

/**
 * warm.mjs가 호출마다 찍는 한 줄. deferred: 글자 예산으로 남긴 곳, chars: 읽은 상세 본문 글자 수 (Task 34),
 * truncated: 후보 고르기가 쪽 상한에서 멈춤, enrichError: 보충 저장 오류(센 수는 그대로, 원인은 Workers 로그)
 * @param {number} i 호출 번호
 * @param {{ incompleteTiles: number, pending: number | string, enriched: number, failed: number, deferred?: number, chars?: number, truncated?: boolean, enrichError?: boolean }} r
 * @returns {string}
 */
export function warmLine(i, r) {
  return `#${i} incompleteTiles=${r.incompleteTiles} pending=${r.pending} enriched=${r.enriched} failed=${r.failed} deferred=${r.deferred ?? 0} chars=${r.chars ?? 0}${r.truncated ? " truncated" : ""}${r.enrichError ? " enrichError" : ""}`;
}

/**
 * warm.mjs가 429가 아닌 실패 응답을 받았거나 요청이 네트워크 오류로 던졌을 때(status 0) — backfill.mjs와 같다.
 * 4xx(401 토큰, 400 인자, 403 read_only)는 다시 해도 같아 바로 멈춘다. 5xx·네트워크 오류는 연속 SERVER_ERROR_LIMIT번까지
 * 기다렸다 다시 한다 (CPU 초과 503 동안 외부 호출 40번짜리 warm을 거점마다 300번 두드리지 않게, 네트워크 한 번에 --all 전체가 끝나지 않게)
 * @param {number} status 응답 상태 (네트워크 오류면 0)
 * @param {number} consecutive 이번을 포함해 연속으로 받은 5xx·네트워크 오류 수 (1부터)
 * @returns {{ action: "retry", waitMs: number } | { action: "stop" }}
 */
export function onWarmFailure(status, consecutive) {
  if (status >= 400 && status < 500) return { action: "stop" };
  return on5xx(consecutive);
}
