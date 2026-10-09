/** R65: 이름을 다시 불러오다 못 찾은 곳 (이번 세션 동안 — 메모리에만, 다음에 시트를 열어도 다시 부르지 않는다) */
export function createFailedNames() {
  const ids = new Set<string>();
  return { has: (id: string) => ids.has(id), add: (id: string) => void ids.add(id) };
}
export const failedNames = createFailedNames();

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
