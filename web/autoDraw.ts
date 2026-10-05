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

/** 문서에서 처음 누르거나(pointerdown) 키를 누르면 true가 되는 ref */
export function useInteracted() {
  const ref = useRef(false);
  useEffect(() => {
    const on = () => {
      ref.current = true;
      document.removeEventListener("pointerdown", on, true);
      document.removeEventListener("keydown", on, true);
    };
    document.addEventListener("pointerdown", on, true);
    document.addEventListener("keydown", on, true);
    return () => {
      document.removeEventListener("pointerdown", on, true);
      document.removeEventListener("keydown", on, true);
    };
  }, []);
  return ref;
}
