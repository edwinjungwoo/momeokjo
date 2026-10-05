/** R22: 뽑기·다시 뽑기 연타 막기 — 마지막으로 받아들인 탭에서 이 시간 안의 탭은 무시한다 (셔플 잠금과 별개) */
export const TAP_GAP_MS = 600;

/**
 * now(ms, 단조 증가 시계)를 받아 이 탭을 받을지 돌려준다. 무시한 탭은 기준 시각을 옮기지 않아서
 * 계속 연타해도 600ms마다 하나씩은 받는다 (이벤트가 쏟아지지 않게, 그렇다고 버튼이 죽지는 않게).
 */
export function createTapGate(gapMs = TAP_GAP_MS): (now: number) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (now) => {
    if (now - last < gapMs) return false;
    last = now;
    return true;
  };
}
