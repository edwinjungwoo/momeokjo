export function limitsFrom(env: Env): { budgetSize: number; batchSize: number; detailCharBudget: number } {
  const budgetSize = Number(env.SUBREQUEST_BUDGET ?? 40);
  const batchSize = Number(env.DETAIL_BATCH_SIZE ?? 10);
  const charBudget = Number(env.DETAIL_CHAR_BUDGET);
  return {
    budgetSize: Number.isFinite(budgetSize) ? budgetSize : 40,
    batchSize: Number.isFinite(batchSize) ? batchSize : 10,
    detailCharBudget: Number.isFinite(charBudget) && charBudget > 0 ? charBudget : DEFAULT_DETAIL_CHAR_BUDGET,
  };
}

/**
 * Task 34: 한 번의 보충(요청·warm·Cron)이 풀 상세 JSON 글자 수. 이만큼 읽으면 새 상세를 시작하지 않는다 (detailEnricher.ts).
 * 운영 값은 wrangler.jsonc vars DETAIL_CHAR_BUDGET (Task 34 수정: 200000). 변수가 없거나 양수가 아니면 이 기본값
 */
export const DEFAULT_DETAIL_CHAR_BUDGET = 600_000;
