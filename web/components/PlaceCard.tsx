import { useEffect, useRef, useState } from "react";
import { lastLevel } from "../../shared/category";
import { photoWideUrl } from "../../shared/photo";
import type { ApiPlace } from "../../shared/types";
import { focusedNow, restoreFocus } from "../focus";
import { openState, priceText, walkText, won } from "../format";
import { HeartButton } from "./HeartButton";
import { CloseIcon } from "./Icons";
import { RankPill } from "./RankPill";
import { Rating } from "./Rating";
import { useSwipeDown } from "./useSwipeDown";

type Props = {
  place: ApiPlace;
  /** 공유 링크로 한 곳만 받았을 때 "공유받은 곳" */
  eyebrow?: string;
  /** R34: 근처 상위 N% */
  topPercent: number | undefined;
  now: Date;
  onClose: () => void;
  onShare: (p: ApiPlace) => void;
  /** R37: 카카오맵을 열면 강한 신호로 기록한다 */
  onKakao: (p: ApiPlace) => void;
  /** R65: 즐겨찾기인가, 제목 옆 ♡를 누름 (넣기·빼기) */
  favorite: boolean;
  onFavorite: (p: ApiPlace) => void;
};

/**
 * R28 한 곳 상세 카드 (목록 행이나 핀에서 연다). 뽑기 결과는 TrioSheet가 보여준다.
 * 모바일은 뽑기 바 위 바텀 시트, 데스크톱은 지도 위 오버레이 (styles.css).
 * 위계: 이름 → 도보·평점·영업 → 카테고리·가격·강점 → 메뉴 → 행동 → 출처
 */
export function PlaceCard({ place, eyebrow, topPercent, now, onClose, onShare, onKakao, favorite, onFavorite }: Props) {
  const [menusOpen, setMenusOpen] = useState(false);
  const [heroFailed, setHeroFailed] = useState(false);
  const swipe = useSwipeDown(onClose);
  const closeBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 카드가 열리면 닫기 버튼으로 초점을 옮기고 (키보드·스크린리더가 카드부터 읽게), 닫히면 연 곳(목록 줄 등)으로 돌려준다
  const [opener] = useState(focusedNow);
  useEffect(() => {
    closeBtn.current?.focus({ preventScroll: true });
    return () => restoreFocus(document, opener);
  }, [opener]);

  const d = place.detail;
  const open = openState(place, now);
  const walk = walkText(place);
  const sub = [lastLevel(place.category), priceText(place), d && d.strengths.length > 0 ? d.strengths.join(", ") : null]
    .filter(Boolean)
    .join(" · ");
  const menus = d?.menus ?? [];

  return (
    <div className="sheet" role="dialog" aria-labelledby="sheet-title" ref={swipe.sheet}>
      <div className="sheet-grab" aria-hidden="true" {...swipe.grab}>
        <div className="sheet-handle" />
      </div>
      <button type="button" className="sheet-close" aria-label="닫기" ref={closeBtn} onClick={onClose}>
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
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h2 className="card-name" id="sheet-title">
            {place.name}
          </h2>
          <p className="facts">
            {walk && <b>{walk}</b>}
            <Rating p={place} />
            <span className={open.closed ? "closed" : undefined}>{open.text}</span>
            <RankPill top={topPercent} />
          </p>
        </div>
        {/* R65: 즐겨찾기 ♡ — 행동 줄(공유·카카오맵)이 아니라 제목 옆 */}
        <HeartButton on={favorite} onToggle={() => onFavorite(place)} />
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
          <button type="button" className="tint" onClick={() => onShare(place)}>
            공유
          </button>
          <a href={place.url} target="_blank" rel="noreferrer" onClick={() => onKakao(place)}>
            카카오맵
          </a>
        </div>
        <p className="source">정보 출처: 카카오맵</p>
      </div>
    </div>
  );
}
