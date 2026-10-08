import { useEffect, useRef, useState, type Ref } from "react";
import type { Hub } from "../../shared/hubs";
import { pickerHubs } from "../hubLines";
import { searchHubs } from "../hubSearch";
import { HubSearchField, noResultText } from "./HubSearchField";
import { LineBadges } from "./LineBadges";
import { CheckIcon, ChevronDown, PinIcon } from "./Icons";
import { Mascot } from "./Mascot";

type Props = {
  hub: Hub;
  onChange: (id: string) => void;
  /** R61: 첫 접속 질문을 닫은 뒤 포커스를 옮길 자리 */
  buttonRef?: Ref<HTMLButtonElement>;
};

/**
 * R24: 거점 칩 — shared/hubs.ts의 공개 거점(R62) 중 하나를 고른다.
 * 위에 역 검색 칸이 있어서 메뉴 역할(menu)이 아니라 대화 상자(dialog)다 — 메뉴 안의 글자 입력칸은 읽기 도구가 글자를 받지 못한다.
 * 역 줄은 그냥 버튼이고 지금 거점은 aria-current(✓).
 */
export function HubChip({ hub, onChange, buttonRef }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [menuWidth, setMenuWidth] = useState<number>();
  const results = searchHubs(pickerHubs(), query);

  /** 키보드로 닫으면(Esc·Enter) 포커스를 칩으로 돌린다 — 열린 칸이 사라지며 포커스를 잃지 않게 */
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus && root.current?.contains(document.activeElement)) {
      root.current.querySelector<HTMLButtonElement>(":scope > button")?.focus({ preventScroll: true });
    }
  };
  const pick = (id: string, refocus = false) => {
    close(refocus);
    if (id !== hub.id) onChange(id);
  };

  // 열 때(전체 목록) 폭을 지킨다 — 거르는 동안 긴 역 줄이 빠져도 메뉴 폭이 출렁이지 않게
  useEffect(() => {
    setMenuWidth(open ? menu.current?.getBoundingClientRect().width : undefined);
  }, [open]);

  // 메뉴 바깥을 누르거나 Esc를 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(true);
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
      <button
        type="button"
        ref={buttonRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          // 다시 열면 빈 검색어부터
          setQuery("");
          setOpen((o) => !o);
        }}
      >
        <PinIcon className="chip-icon" />
        <span className="chip-label">{hub.name}</span>
        <ChevronDown className="caret" />
      </button>
      {open && (
        <div className="menu" role="dialog" aria-label="어디서 찾을까요?" ref={menu} style={menuWidth ? { minWidth: menuWidth } : undefined}>
          <div className="menu-head" aria-hidden="true">
            <Mascot pose="location" height={36} eager />
            <span>어디서 찾을까요?</span>
          </div>
          <HubSearchField
            value={query}
            onChange={setQuery}
            onEnter={() => results[0] && pick(results[0].id, true)}
            count={results.length}
          />
          {results.map((h) => (
            <button
              key={h.id}
              type="button"
              className="menu-item"
              aria-current={h.id === hub.id ? "true" : undefined}
              onClick={() => pick(h.id)}
            >
              <span className="menu-hub">
                <span>{h.name}</span>
                <LineBadges hubId={h.id} />
              </span>
              {h.id === hub.id && <CheckIcon className="menu-check" />}
            </button>
          ))}
          {results.length === 0 && <p className="menu-empty">{noResultText(query)}</p>}
        </div>
      )}
    </div>
  );
}
