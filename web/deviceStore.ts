/**
 * 이 기기에 남기는 작은 값들 (설정 R25·R61, 첫 방문 안내 R39·R61). 읽기·쓰기는 예외를 던지지 않는다.
 * 저장소는 테스트에서 바꿔 끼울 수 있게 인자로 받는다 (기본은 브라우저 localStorage·sessionStorage).
 */
type Store = Pick<Storage, "getItem" | "setItem">;

export const SETTINGS_KEY = "mmj:settings:v1";
export const TIP_KEY = "mmj:tip-draw:v1";

/** 접근만 해도 예외가 나는 환경(저장소 차단)이 있어서 꺼내는 것도 감싼다 */
function local(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}
function session(): Store | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}
function get(s: Store | null, key: string): string | null {
  try {
    return s?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function set(s: Store | null, key: string, value: string): boolean {
  if (!s) return false;
  try {
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * R25/R61: 설정 저장값. localStorage가 먼저이고, 거기 없으면 sessionStorage —
 * localStorage에 쓸 수 없는 환경(사생활 보호 모드 등)에서 같은 탭을 새로고침해도 거점 질문을 다시 하지 않게
 */
export function readSettingsRaw(l: Store | null = local(), s: Store | null = session()): string | null {
  return get(l, SETTINGS_KEY) ?? get(s, SETTINGS_KEY);
}

/** R25/R61: 설정을 쓴다. localStorage에 못 쓰면 sessionStorage에 (이번 탭만) */
export function writeSettingsRaw(raw: string, l: Store | null = local(), s: Store | null = session()): void {
  if (!set(l, SETTINGS_KEY, raw)) set(s, SETTINGS_KEY, raw);
}

/** R39/R61: 첫 방문 안내를 닫은 기기인가 (재방문자·기존 사용자 판단) */
export function firstTipSeen(l: Store | null = local()): boolean {
  return get(l, TIP_KEY) === "1";
}

/** 첫 방문 안내를 닫았다고 기억한다 (저장이 안 되면 이번 세션만 — 화면 상태로) */
export function markFirstTipSeen(l: Store | null = local()): void {
  set(l, TIP_KEY, "1");
}
