import { useEffect, useRef, type KeyboardEvent } from "react";
import { CloseIcon, SearchIcon } from "./Icons";

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Enter(키보드의 "이동") → 첫 결과를 고른다 */
  onEnter: () => void;
  /** 지금 결과 수 — 읽기 도구에 알린다 */
  count: number;
  /** 글자가 있을 때 Esc는 글자만 지운다 (첫 접속 질문: Esc가 기본 거점을 고르고 닫으므로 실수로 닫히지 않게) */
  escClears?: boolean;
};

/** 결과가 없을 때 조용한 안내 (목록 자리·읽기 도구 알림 같은 문구) */
export const noResultText = (query: string) => `‘${query.trim()}’ 역은 아직 없어요`;

/** 마우스·트랙패드 같은 정밀 포인터 — 폰에서는 자동 포커스로 키보드를 띄우지 않는다 */
export const finePointer = () => typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;

/**
 * R24·R61: 역 고르기(헤더 메뉴·첫 접속 질문) 목록 위의 역 검색 칸. 거르기는 부모가 searchHubs로 한다.
 * 정밀 포인터에서만 열리자마자 포커스, 16px 글자(iOS 확대 없음), 44px 높이, 글자가 있으면 지우기(✕).
 */
export function HubSearchField({ value, onChange, onEnter, count, escClears = false }: Props) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (finePointer()) input.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    } else if (e.key === "Escape" && escClears && value !== "") {
      e.preventDefault();
      e.stopPropagation();
      onChange("");
    }
  };

  const typed = value.trim() !== "";
  return (
    <div className="hub-search">
      <SearchIcon className="hub-search-icon" />
      <input
        ref={input}
        className="hub-search-input"
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="역 이름·호선 검색"
        aria-label="역 검색"
        enterKeyHint="go"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
      />
      {value !== "" && (
        <button
          type="button"
          className="hub-search-clear"
          aria-label="지우기"
          onClick={() => {
            onChange("");
            input.current?.focus({ preventScroll: true });
          }}
        >
          <span className="hub-search-clear-dot">
            <CloseIcon size={10} />
          </span>
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        {typed ? (count > 0 ? `결과 ${count}곳` : noResultText(value)) : ""}
      </span>
    </div>
  );
}
