import { useEffect, useRef, type KeyboardEvent } from "react";
import { HUBS } from "../../shared/hubs";
import { CloseIcon, PinIcon } from "./Icons";
import { Mascot } from "./Mascot";
import { useSwipeDown } from "./useSwipeDown";

type Props = {
  /** 거점 한 줄을 누름 → 고르고 저장하고 닫는다 */
  onPick: (hubId: string) => void;
  /** ✕·아래로 끌기·Esc → 기본 거점으로 고른 것으로 치고 닫는다 */
  onDismiss: () => void;
};

/**
 * R61: 첫 접속 때 한 번만 묻는 거점 고르기 (결과 시트와 같은 바텀 시트, 데스크톱은 가운데 창).
 * 확인 버튼 없이 한 번 누르면 끝. 거점이 6곳을 넘으면 목록만 시트 안에서 스크롤한다.
 * 뒤 화면은 App이 inert로 막고, 여기서는 Tab을 시트 안에서 돌린다 (포커스 가두기).
 */
export function HubPicker({ onPick, onDismiss }: Props) {
  const swipe = useSwipeDown(onDismiss);
  const title = useRef<HTMLHeadingElement>(null);

  // 제목에 포커스 — 스크린리더가 질문부터 읽고, 첫 줄(봉은사역)에 포커스 테두리가 떠서 미리 고른 것처럼 보이지 않게
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
  }, []);

  // Esc는 포커스가 시트 밖(배경을 눌러 body로 감)이어도 받는다
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

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
      <div className="picker-scrim" aria-hidden="true" />
      <div
        className="sheet picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="picker-title"
        aria-describedby="picker-hint"
        ref={swipe.sheet}
        onKeyDown={onKeyDown}
      >
        <div className="sheet-grab" aria-hidden="true" {...swipe.grab}>
          <div className="sheet-handle" />
        </div>
        <button type="button" className="sheet-close" aria-label="닫기" onClick={onDismiss}>
          <CloseIcon />
        </button>
        <div className="picker-head">
          <Mascot pose="location" height={60} eager />
          <div className="picker-head-text">
            <h2 className="picker-title" id="picker-title" tabIndex={-1} ref={title}>
              어느 역 근처에서 점심 드세요?
            </h2>
            <p className="picker-hint" id="picker-hint">
              나중에 위에서 바꿀 수 있어요
            </p>
          </div>
        </div>
        <ul className="picker-list">
          {HUBS.map((h) => (
            <li key={h.id}>
              <button type="button" className="picker-row" onClick={() => onPick(h.id)}>
                <PinIcon className="picker-pin" size={18} />
                <span className="picker-name">{h.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
