import { useEffect, useRef } from "react";

/** R39: 이번 탭 세션에 자동으로 뽑았는지 (sessionStorage), 자동 뽑기를 끈 날 (localStorage). 못 쓰면 이번 페이지만 */
const SESSION_KEY = "mmj:auto-draw:v1";
const OFF_KEY = "mmj:auto-draw-off";
let memDrawn = false;
let memOff: string | null = null;

export function autoDrawnThisSession(): boolean {
  try {
    return memDrawn || sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return memDrawn;
  }
}

export function markAutoDrawn() {
  memDrawn = true;
  try {
    sessionStorage.setItem(SESSION_KEY, "1");
  } catch {
    /* 메모리에만 */
  }
}

export function autoDrawOffDay(): string | null {
  try {
    return localStorage.getItem(OFF_KEY) ?? memOff;
  } catch {
    return memOff;
  }
}

/** 자동으로 뜬 시트를 닫으면 그날은 다시 띄우지 않는다 */
export function turnOffAutoDraw(day: string) {
  memOff = day;
  try {
    localStorage.setItem(OFF_KEY, day);
  } catch {
    /* 메모리에만 */
  }
}

/** 사용자가 이미 무언가 한 것으로 치는 첫 입력 (누름, 키, 휠 스크롤, 터치 시작) */
const INTERACTIONS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/** 문서에서 처음 누르거나 키를 누르거나 휠·터치로 스크롤하기 시작하면 true가 되는 ref */
export function useInteracted() {
  const ref = useRef(false);
  useEffect(() => {
    const off = () => {
      for (const t of INTERACTIONS) document.removeEventListener(t, on, true);
    };
    const on = () => {
      ref.current = true;
      off();
    };
    // 휠·터치는 스크롤을 막지 않게 passive로 듣는다
    for (const t of INTERACTIONS) document.addEventListener(t, on, { capture: true, passive: true });
    return off;
  }, []);
  return ref;
}
