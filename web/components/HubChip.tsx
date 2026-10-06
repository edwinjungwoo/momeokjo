import { useEffect, useRef, useState, type Ref } from "react";
import { PUBLIC_HUBS, type Hub } from "../../shared/hubs";
import { CheckIcon, ChevronDown, PinIcon } from "./Icons";
import { Mascot } from "./Mascot";

type Props = {
  hub: Hub;
  onChange: (id: string) => void;
  /** R61: 첫 접속 질문을 닫은 뒤 포커스를 옮길 자리 */
  buttonRef?: Ref<HTMLButtonElement>;
};

/** R24: 거점 칩 — shared/hubs.ts의 공개 거점(R62) 중 하나를 고른다 */
export function HubChip({ hub, onChange, buttonRef }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // 메뉴 바깥을 누르거나 Esc를 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="hub-chip" ref={root}>
      <button type="button" ref={buttonRef} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <PinIcon className="chip-icon" />
        <span className="chip-label">{hub.name}</span>
        <ChevronDown className="caret" />
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="어디서 찾을까요?">
          <div className="menu-head" aria-hidden="true">
            <Mascot pose="location" height={36} eager />
            <span>어디서 찾을까요?</span>
          </div>
          {PUBLIC_HUBS.map((h) => (
            <button
              key={h.id}
              type="button"
              role="menuitemradio"
              aria-checked={h.id === hub.id}
              onClick={() => {
                setOpen(false);
                if (h.id !== hub.id) onChange(h.id);
              }}
            >
              <span>{h.name}</span>
              {h.id === hub.id && <CheckIcon className="menu-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
