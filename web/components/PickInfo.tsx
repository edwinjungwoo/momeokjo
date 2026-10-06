import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { PICK_INFO_LINES } from "../pickInfo";
import { CloseIcon } from "./Icons";
import { useSwipeDown } from "./useSwipeDown";

/**
 * R64: "모먹죠는 이렇게 골라요" — 결과 시트 제목 옆 ⓘ가 여는 작은 바텀 시트(데스크톱은 가운데 창).
 * 한 줄 한 줄이 shared/recommend.ts의 실제 규칙을 말한다 (규칙을 바꾸면 이 문구도 같이).
 * 닫기: ✕ · 바깥(어두운 배경) · Esc · 아래로 끌기. 열면 제목에 포커스, 닫으면 눌렀던 버튼으로 돌려준다.
 * 뒤 화면은 App이 inert로 막는다.
 */
export function PickInfo({ onClose }: { onClose: () => void }) {
  const swipe = useSwipeDown(onClose);
  const title = useRef<HTMLHeadingElement>(null);
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    // 뒤 화면의 inert가 풀린 뒤(이 effect 정리는 DOM 반영 뒤에 돈다) 열었던 버튼으로 포커스를 돌려준다
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  // Esc는 포커스가 시트 밖(배경을 눌러 body로 감)이어도 받는다. 결과 시트의 Esc는 이 시트가 떠 있는 동안 비켜선다
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("button:not([disabled])")];
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <>
      <div className="picker-scrim" aria-hidden="true" onClick={onClose} />
      <div className="sheet info" role="dialog" aria-modal="true" aria-labelledby="info-title" ref={swipe.sheet} onKeyDown={onKeyDown}>
        <div className="sheet-grab" aria-hidden="true" {...swipe.grab}>
          <div className="sheet-handle" />
        </div>
        <button type="button" className="sheet-close" aria-label="닫기" onClick={onClose}>
          <CloseIcon />
        </button>
        <h2 className="info-title" id="info-title" tabIndex={-1} ref={title}>
          모먹죠는 이렇게 골라요
        </h2>
        <ul className="info-list">
          {PICK_INFO_LINES.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
    </>
  );
}
