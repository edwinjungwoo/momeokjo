import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type Ref } from "react";
import type { MineItem, MineSections } from "../../shared/mine";
import { HeartButton } from "./HeartButton";
import { CloseIcon, HeartIcon } from "./Icons";
import { Mascot } from "./Mascot";
import { useSwipeDown } from "./useSwipeDown";

/** R65: 헤더(거점 칩 왼쪽)의 "내 가게" — 조용한 선 하트, 누르는 영역 44px */
export function MineButton({ onClick, buttonRef }: { onClick: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  return (
    <button type="button" className="mine-btn" aria-label="내 가게" aria-haspopup="dialog" ref={buttonRef} onClick={onClick}>
      <HeartIcon size={22} />
    </button>
  );
}

type Props = {
  sections: MineSections;
  /** 줄을 누름 → 지금 목록에 있으면 그 카드, 아니면 가까운 역으로 옮겨서 (App) */
  onOpen: (item: MineItem) => void;
  /** 즐겨찾기·최근 줄의 ♡ (on = 넣기) */
  onToggleFavorite: (item: MineItem, on: boolean) => void;
  /** 뺀 곳의 "다시 보기" */
  onRestore: (item: MineItem) => void;
  onClose: () => void;
};

type Kind = "favorites" | "recent" | "excluded";
/** 방금 누른 줄 (♡ 빼기·다시 보기로 그 줄이 사라지면 포커스를 옮길 자리를 찾는다) */
type Removing = { kind: Kind; id: string; index: number };

/**
 * R65: 줄이 사라진 뒤 포커스 — 그 묶음의 다음 줄(남은 줄의 같은 자리) → 묶음 제목 → (묶음이 비어 사라졌으면) 시트 제목
 */
export function focusAfterRemove(remaining: readonly string[], index: number): { row: string } | "heading" | "title" {
  if (remaining.length === 0) return "title";
  return index < remaining.length ? { row: remaining[index] } : "heading";
}

function Section({ kind, title, caption, items, props, removing }: {
  kind: Kind; title: string; caption?: string; items: MineItem[]; props: Props; removing: MutableRefObject<Removing | null>;
}) {
  if (items.length === 0) return null;
  const headId = `mine-${kind}`;
  const mark = (id: string, index: number) => {
    removing.current = { kind, id, index };
  };
  return (
    <section className="mine-section" aria-labelledby={headId}>
      <h3 className="mine-head" id={headId} tabIndex={-1}>{title}</h3>
      {caption && <p className="mine-caption">{caption}</p>}
      <ul className="mine-list">
        {items.map((it, i) => (
          <li key={it.id} className="mine-row" data-id={it.id}>
            <button type="button" className="mine-open" aria-busy={it.loading || undefined} onClick={() => props.onOpen(it)}>
              {it.loading ? (
                // 3일 지난 이름을 단건으로 다시 불러오는 동안 이름 자리 뼈대
                <span className="mine-name mine-skeleton">
                  <span className="sr-only">불러오는 중</span>
                </span>
              ) : (
                <span className="mine-name">{it.name}</span>
              )}
              {it.line && <span className="mine-line">{it.line}</span>}
            </button>
            {kind === "excluded" ? (
              // 이름을 불러오는 동안은 누를 수 없다 (알림에 이름이 들어가서)
              <button
                type="button"
                className="mine-restore"
                disabled={it.loading}
                onClick={() => {
                  mark(it.id, i);
                  props.onRestore(it);
                }}
              >
                다시 보기
              </button>
            ) : (
              <HeartButton
                on={kind === "favorites"}
                onToggle={() => {
                  mark(it.id, i);
                  props.onToggleFavorite(it, kind !== "favorites");
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * R65 "내 가게": 즐겨찾기 · 최근 열어 본 곳 · 뺀 곳 (이 기기에만 있는 것, 서버를 부르지 않는다).
 * 거점 고르기(R61)·설명(R64)과 같은 바텀 시트(데스크톱은 가운데 창). 제목은 그대로 두고 목록만 스크롤한다.
 * 닫기: ✕ · 바깥(어두운 배경) · Esc · 아래로 끌기. 열면 제목에 포커스, 닫으면 눌렀던 버튼으로 돌려준다 (Tab은 시트 안에서 돈다).
 * 뒤 화면은 App이 inert로 막는다.
 */
export function MineSheet(props: Props) {
  const { sections, onClose } = props;
  const swipe = useSwipeDown(onClose);
  const title = useRef<HTMLHeadingElement>(null);
  // 정적 렌더(테스트)에는 document가 없다
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement));

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    // 뒤 화면의 inert가 풀린 뒤(이 effect 정리는 DOM 반영 뒤에 돈다) 열었던 버튼으로 포커스를 돌려준다.
    // 줄을 눌러 카드를 열면 카드가 그 뒤에 자기 닫기 버튼으로 포커스를 가져간다
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  // Esc는 이 시트만 닫는다 — 뒤의 결과 시트·카드도 window에서 Esc를 듣기 때문에 캡처 단계에서 먼저 받고 멈춘다
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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

  // R65: ♡ 빼기·다시 보기로 누른 줄이 그 묶음에서 사라지면 포커스를 다음 줄 → 묶음 제목 → 시트 제목으로 옮긴다
  const removing = useRef<Removing | null>(null);
  useEffect(() => {
    const r = removing.current;
    if (!r) return;
    removing.current = null;
    const remaining = sections[r.kind].map((it) => it.id);
    if (remaining.includes(r.id)) return;
    const target = focusAfterRemove(remaining, r.index);
    const head = document.getElementById(`mine-${r.kind}`);
    if (target === "title") title.current?.focus({ preventScroll: true });
    else if (target === "heading") head?.focus({ preventScroll: true });
    else head?.closest("section")?.querySelector<HTMLElement>(`[data-id="${target.row}"] .mine-open`)?.focus();
  }, [sections]);

  const empty = sections.favorites.length + sections.recent.length + sections.excluded.length === 0;
  return (
    <>
      <div className="picker-scrim" aria-hidden="true" onClick={onClose} />
      <div className="sheet mine" role="dialog" aria-modal="true" aria-labelledby="mine-title" ref={swipe.sheet} onKeyDown={onKeyDown}>
        <div className="sheet-grab" aria-hidden="true" {...swipe.grab}>
          <div className="sheet-handle" />
        </div>
        <button type="button" className="sheet-close" aria-label="닫기" onClick={onClose}>
          <CloseIcon />
        </button>
        <h2 className="mine-title" id="mine-title" tabIndex={-1} ref={title}>
          내 가게
        </h2>
        {empty ? (
          <div className="state mine-empty">
            <Mascot pose="love" height={72} eager />
            <p className="state-title">아직 모은 가게가 없어요</p>
            <p className="state-desc">카드의 ♡를 누르면 여기 모여요</p>
          </div>
        ) : (
          <div className="mine-body">
            <Section kind="favorites" title="즐겨찾기" items={sections.favorites} props={props} removing={removing} />
            <Section
              kind="recent" title="최근 열어 본 곳" caption="카카오맵을 열었거나 공유한 곳이에요" items={sections.recent} props={props}
              removing={removing}
            />
            <Section kind="excluded" title="뺀 곳" items={sections.excluded} props={props} removing={removing} />
          </div>
        )}
      </div>
    </>
  );
}
