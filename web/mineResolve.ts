/** R65: 내 가게를 열 때 이름을 다시 불러오는 동시 수 */
export const RESOLVE_CONCURRENCY = 3;

/**
 * ids를 앞에서부터 동시에 limit개까지 run한다. 하나가 실패해도(예: 404) 조용히 다음으로 간다.
 * signal이 멈추면 새로 시작하지 않는다 (이미 시작한 것은 run이 signal로 멈춘다)
 */
export async function forEachLimited(
  ids: readonly string[], limit: number, run: (id: string) => Promise<void>, signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < ids.length && !signal?.aborted) {
      const id = ids[next++];
      try {
        await run(id);
      } catch {
        /* 못 찾으면 "이전에 담은 가게"로 둔다 */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker));
}
