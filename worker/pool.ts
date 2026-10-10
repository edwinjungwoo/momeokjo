/**
 * items를 동시에 limit개까지 fn으로 처리한다. fn 하나가 실패하면 새 항목은 시작하지 않고, 이미 시작한 항목이 다 끝난 뒤에
 * 처음 난 오류로 거부한다 — 거부한 뒤에도 부른 쪽 몰래 남은 항목을 계속 도는 작업(외부 호출·D1 쓰기)이 없게
 */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (failure === null && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(workers);
  if (failure !== null) throw (failure as { error: unknown }).error;
}
