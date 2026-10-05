import { useRef, type PointerEvent } from "react";

const SWIPE_CLOSE_PX = 80;

/** 그래버를 아래로 80px 넘게 끌면 닫는다. 덜 끌면 제자리로 돌아온다. 끄는 동안은 리렌더 없이 transform만 바꾼다 */
export function useSwipeDown(onClose: () => void) {
  const sheet = useRef<HTMLDivElement>(null);
  const start = useRef<number | null>(null);
  const dy = (e: PointerEvent) => Math.max(0, e.clientY - (start.current ?? e.clientY));
  return {
    sheet,
    grab: {
      onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
        start.current = e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
        if (sheet.current) sheet.current.style.transition = "none";
      },
      onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
        if (start.current === null || !sheet.current) return;
        sheet.current.style.transform = `translateY(${dy(e)}px)`;
      },
      onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
        if (start.current === null) return;
        const moved = dy(e);
        start.current = null;
        if (moved > SWIPE_CLOSE_PX) return onClose();
        if (sheet.current) {
          sheet.current.style.transition = "transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.2)";
          sheet.current.style.transform = "";
        }
      },
      onPointerCancel: () => {
        start.current = null;
        if (sheet.current) sheet.current.style.transform = "";
      },
    },
  };
}
