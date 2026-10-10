import { markSeen, mergeSeen, parseSeen, pruneSeen, type Seen } from "../shared/seen";

const KEY = "mmj:seen:v1";

/** 이 탭의 기억. 처음 쓸 때 저장본을 한 번 읽고, 저장소가 막혀 있으면 이번 세션 메모리에만 둔다 */
let memory: Seen | null = null;

function current(): Seen {
  if (memory) return memory;
  try {
    memory = pruneSeen(parseSeen(localStorage.getItem(KEY)), Date.now());
  } catch {
    memory = {};
  }
  return memory;
}

/**
 * R46: 지금까지 이 기기에서 본 곳. 결과를 띄우기 *전*에 받아 두면 그 결과의 "처음 보는 곳" 판단에 쓴다
 * (받은 객체는 나중 기록으로 바뀌지 않는다).
 */
export const seenSnapshot = (): Seen => current();

/**
 * R46: 결과(직접·자동 뽑기, 공유받은 후보)와 목록·핀에서 연 카드로 보여준 곳을 기억한다. 저장 실패는 조용히 넘긴다.
 * 쓸 때마다 저장본을 다시 읽어 합친다 — 다른 탭이 그사이 기억한 곳을 덮어 지우지 않게. 그때 읽지 못하면 쓰지 않는다
 * (이번 세션 기억만으로 저장된 기억을 덮지 않게 — 이번 세션 메모리에는 남는다)
 */
export function recordSeen(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  memory = markSeen(current(), ids, now);
  let stored: Seen;
  try {
    stored = parseSeen(localStorage.getItem(KEY));
  } catch {
    return;
  }
  memory = mergeSeen(memory, stored, now);
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* 저장할 수 없는 환경 — 이번 세션만 */
  }
}
