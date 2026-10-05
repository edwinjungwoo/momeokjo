// backfill.mjs의 인자 해석과 5xx 처리 (R12, R38). node와 테스트(workerd) 둘 다에서 돌도록 의존성 없음
/** 연속으로 5xx를 받으면 이만큼에서 멈춘다 (서버가 죽었거나 배포가 잘못됐는데 MAX_CALLS번 두드리지 않게) */
export const SERVER_ERROR_LIMIT = 3;
export const SERVER_ERROR_WAIT_MS = 3000;
/** 서버의 ADMIN_BACKFILL_MAX(worker/repo.ts)와 같다 — 더 큰 limit은 서버가 줄이므로 미리 막는다 */
export const BACKFILL_LIMIT_MAX = 300;

/**
 * @param {number} consecutive 이번 응답을 포함해 연속으로 받은 5xx 횟수 (1부터)
 * @returns {{ action: "retry", waitMs: number } | { action: "stop" }}
 */
export function on5xx(consecutive) {
  return consecutive < SERVER_ERROR_LIMIT ? { action: "retry", waitMs: SERVER_ERROR_WAIT_MS } : { action: "stop" };
}

/**
 * npm run backfill -- [--hub <거점 id>] [--limit N] 인자를 해석한다 (순서 무관, 같은 플래그 두 번은 오류).
 * @param {string[]} args
 * @param {string[]} hubIds 가능한 거점 id
 * @returns {{ ok: true, hub: string | undefined, limit: number | undefined } | { ok: false, error: string }}
 */
export function parseBackfillArgs(args, hubIds) {
  const usage = "사용법: npm run backfill [-- --hub <거점 id>] [--limit 1~" + BACKFILL_LIMIT_MAX + "]";
  let hub;
  let limit;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--hub" && hub === undefined) {
      if (value === undefined || !hubIds.includes(value)) {
        return { ok: false, error: `모르는 거점이에요: ${value ?? ""} (가능: ${hubIds.join(", ")})` };
      }
      hub = value;
    } else if (flag === "--limit" && limit === undefined) {
      if (value === undefined || !/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > BACKFILL_LIMIT_MAX) {
        return { ok: false, error: `--limit은 1~${BACKFILL_LIMIT_MAX} 사이 정수예요: ${value ?? ""}` };
      }
      limit = Number(value);
    } else {
      return { ok: false, error: usage };
    }
  }
  return { ok: true, hub, limit };
}
