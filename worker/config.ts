export function limitsFrom(env: Env): { budgetSize: number; batchSize: number } {
  const budgetSize = Number(env.SUBREQUEST_BUDGET ?? 40);
  const batchSize = Number(env.DETAIL_BATCH_SIZE ?? 10);
  return {
    budgetSize: Number.isFinite(budgetSize) ? budgetSize : 40,
    batchSize: Number.isFinite(batchSize) ? batchSize : 10,
  };
}
