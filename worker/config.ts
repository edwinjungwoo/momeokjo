export function limitsFrom(env: Env): {
  budgetSize: number; batchSize: number; detailCharBudget: number; detailOnlyReadShare: number;
} {
  const budgetSize = Number(env.SUBREQUEST_BUDGET ?? 40);
  const batchSize = Number(env.DETAIL_BATCH_SIZE ?? MAX_DETAIL_BATCH_SIZE);
  const charBudget = Number(env.DETAIL_CHAR_BUDGET);
  const rawShare: string | undefined = env.DETAIL_ONLY_READ_SHARE;
  const share = rawShare === undefined || rawShare === "" ? Number.NaN : Number(rawShare);
  return {
    budgetSize: Number.isFinite(budgetSize) ? budgetSize : 40,
    // 천장으로 자른다 (음수는 0, 소수는 내림)
    batchSize: Number.isFinite(batchSize) ? Math.min(MAX_DETAIL_BATCH_SIZE, Math.max(0, Math.floor(batchSize))) : MAX_DETAIL_BATCH_SIZE,
    detailCharBudget: Number.isFinite(charBudget) && charBudget > 0 ? charBudget : DEFAULT_DETAIL_CHAR_BUDGET,
    // R63: 상세만 실행은 오늘 읽기가 소프트 한도의 이 비율에 닿으면 비켜선다 (0 < 값 ≤ 1, 아니면 기본값)
    detailOnlyReadShare: Number.isFinite(share) && share > 0 && share <= 1 ? share : DEFAULT_DETAIL_ONLY_READ_SHARE,
  };
}

/**
 * R63 채우기 부스트: 둘째 트리거(매 분)의 짝수 분(5의 배수 빼고, 시간당 24번)에도 상세만 보충을 돌릴지. wrangler.jsonc vars
 * DETAIL_ONLY_EXTRA가 정확히 "1"일 때만 켠다 — 끄려면 "0"으로 배포한다 (트리거는 그대로, 짝수 분은 쉼)
 */
export function detailOnlyExtraFrom(env: Env): boolean {
  const v: string | undefined = env.DETAIL_ONLY_EXTRA;
  return v === "1";
}

/**
 * R63: 둘째 트리거의 상세만 실행(홀수 분)이 비켜서는 읽기 비율 — 오늘(UTC) D1 읽기가 D1_READ_SOFT_CAP × 이 값 이상이면 건너뛴다
 * (`skipped: "read_share"`). 남은 몫(소프트 한도까지)은 본 Cron(격자·완료·집계)과 스냅샷이 쓴다. 운영 값은 wrangler.jsonc
 * vars DETAIL_ONLY_READ_SHARE (0.6 = 300만 행 중 180만 행)
 */
export const DEFAULT_DETAIL_ONLY_READ_SHARE = 0.6;

/**
 * Task 34: 한 번의 보충(요청·warm·Cron)이 풀 상세 JSON 글자 수. 이만큼 읽으면 새 상세를 시작하지 않는다 (detailEnricher.ts).
 * 운영 값은 wrangler.jsonc vars DETAIL_CHAR_BUDGET (Task 34 수정: 200000). 변수가 없거나 양수가 아니면 이 기본값
 */
export const DEFAULT_DETAIL_CHAR_BUDGET = 600_000;

/**
 * Task 34: DETAIL_BATCH_SIZE의 천장 (더 크면 이 값으로 자른다, 변수가 없을 때의 기본값).
 * 무료 플랜 D1 질의 50개/실행 안에서 보통 Cron 실행이 만료 후보·격자 수집·미수집 걷기·집계를 다 하고도 보충 최악
 * (곳마다 한 곳씩 다시 저장 + 차단 기록)이 들어가는 가장 큰 값이다 — maintenance.ts cronBatchFor와 테스트가 같은 값을 확인한다.
 * 실제 한 실행의 배치는 남은 D1 호출에 맞춰 더 작아질 수 있다 (보관 정리 실행 등)
 */
export const MAX_DETAIL_BATCH_SIZE = 8;
