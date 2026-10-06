export function limitsFrom(env: Env): { budgetSize: number; batchSize: number; detailCharBudget: number } {
  const budgetSize = Number(env.SUBREQUEST_BUDGET ?? 40);
  const batchSize = Number(env.DETAIL_BATCH_SIZE ?? 10);
  // wrangler.jsonc vars에 없는 선택 변수라 Env 타입에 없다
  const charBudget = Number((env as unknown as Record<string, string | undefined>).DETAIL_CHAR_BUDGET);
  return {
    budgetSize: Number.isFinite(budgetSize) ? budgetSize : 40,
    batchSize: Number.isFinite(batchSize) ? batchSize : 10,
    detailCharBudget: Number.isFinite(charBudget) && charBudget > 0 ? charBudget : DEFAULT_DETAIL_CHAR_BUDGET,
  };
}

/**
 * Task 34: 한 번의 보충(요청·warm·Cron)이 풀 상세 JSON 글자 수. 이만큼 읽으면 새 상세를 시작하지 않는다 (detailEnricher.ts).
 * 운영에서 바꾸려면 DETAIL_CHAR_BUDGET 변수 (양수가 아니면 기본값)
 */
export const DEFAULT_DETAIL_CHAR_BUDGET = 600_000;
