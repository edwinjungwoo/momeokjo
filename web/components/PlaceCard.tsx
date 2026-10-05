import { useEffect, useRef, useState, type PointerEvent } from "react";
import { lastLevel } from "../../shared/category";
import { photoWideUrl } from "../../shared/photo";
import type { ApiPlace } from "../../shared/types";
import { openState, priceText, walkText, won } from "../format";
import { CloseIcon } from "./Icons";
import { Mascot } from "./Mascot";
import { Rating } from "./Rating";

type Props = {
  place: ApiPlace | null;
  slotName: string | null;
  drawn: boolean;
  now: Date;
  onClose: () => void;
  onRedraw: () => void;
  onShare: (p: ApiPlace) => void;
};

const SWIPE_CLOSE_PX = 80;

/** 그래버를 아래로 80px 넘게 끌면 닫는다. 덜 끌면 제자리로 돌아온다. 끄는 동안은 리렌더 없이 transform만 바꾼다 */
function useSwipeDown(onClose: () => void) {
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

/**
 * R22/R28 결과·상세 카드. 모바일은 뽑기 바 위 바텀 시트, 데스크톱은 지도 위 오버레이 (styles.css).
 * 위계: 이름 → 도보·평점·영업 → 카테고리·가격·강점 → 메뉴 → 행동 → 출처
 */
export function PlaceCard({ place, slotName, drawn, now, onClose, onRedraw, onShare }: Props) {
  const [menusOpen, setMenusOpen] = useState(false);
  const [heroFailed, setHeroFailed] = useState(false);
  const swipe = useSwipeDown(onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (slotName !== null) {
    return (
      <div className="sheet is-slot" aria-busy="true">
        <div className="sheet-handle" aria-hidden="true" />
        <div className="card-head">
          <div className="card-head-text">
            <p className="eyebrow">모먹죠가 고르는 중…</p>
            <h2 className="card-name" key={slotName}>
              {slotName}
            </h2>
          </div>
          <Mascot pose="search" height={60} className="mascot-bob" eager />
        </div>
      </div>
    );
  }
  if (!place) return null;

  const d = place.detail;
  const open = openState(place, now);
  const walk = walkText(place);
  const sub = [lastLevel(place.category), priceText(place), d && d.strengths.length > 0 ? d.strengths.join(", ") : null]
    .filter(Boolean)
    .join(" · ");
  const menus = d?.menus ?? [];

  return (
    <div className="sheet" role="dialog" aria-labelledby="sheet-title" aria-live="polite" ref={swipe.sheet}>
      <div className="sheet-grab" aria-hidden="true" {...swipe.grab}>
        <div className="sheet-handle" />
      </div>
      <button type="button" className="sheet-close" aria-label="닫기" onClick={onClose}>
        <CloseIcon />
      </button>
      {place.photoUrl && !heroFailed && (
        <img
          className="hero"
          src={photoWideUrl(place.photoUrl)}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setHeroFailed(true)}
        />
      )}
      <div className="card-head">
        <div className="card-head-text">
          {drawn && <p className="eyebrow">모먹죠가 찾았어요!</p>}
          <h2 className="card-name" id="sheet-title">
            {place.name}
          </h2>
          <p className="facts">
            {walk && <b>{walk}</b>}
            <Rating p={place} />
            <span className={open.closed ? "closed" : undefined}>{open.text}</span>
          </p>
        </div>
        {drawn && <Mascot pose="thumbsup" height={56} eager />}
      </div>
      {sub && <p className="sub">{sub}</p>}
      {!d && <p className="sub">평점과 메뉴 정보를 아직 불러오지 못했어요</p>}
      {menus.length > 0 && (
        <>
          <ul className={`menus${menusOpen ? " is-open" : ""}`}>
            {menus.map((m, i) => (
              <li key={`${m.name}-${i}`}>
                <span>{m.name}</span>
                <span>{won(m.price)}</span>
              </li>
            ))}
          </ul>
          {menus.length > 3 && !menusOpen && (
            <button type="button" className="menus-more" onClick={() => setMenusOpen(true)}>
              메뉴 더보기 ({menus.length - 3})
            </button>
          )}
        </>
      )}
      {/* 행동 버튼은 시트 아래쪽에 붙어 있어서 내용이 길어도 항상 보인다 */}
      <div className="sheet-foot">
        <div className="actions">
          {drawn && (
            <button type="button" className="redraw" onClick={onRedraw}>
              다시 뽑기
            </button>
          )}
          <button type="button" className="tint" onClick={() => onShare(place)}>
            공유
          </button>
          <a href={place.url} target="_blank" rel="noreferrer">
            카카오맵
          </a>
        </div>
        <p className="source">정보 출처: 카카오맵</p>
      </div>
    </div>
  );
}
