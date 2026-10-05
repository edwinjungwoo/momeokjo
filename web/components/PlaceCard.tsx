import { useEffect, useState } from "react";
import { lastLevel } from "../../shared/category";
import { photoWideUrl } from "../../shared/photo";
import type { ApiPlace } from "../../shared/types";
import { openState, priceText, ratingText, walkText, won } from "../format";

type Props = {
  place: ApiPlace | null;
  slotName: string | null;
  drawn: boolean;
  now: Date;
  onClose: () => void;
  onRedraw: () => void;
  onShare: (p: ApiPlace) => void;
};

/**
 * R22/R28 결과·상세 카드. 모바일은 뽑기 바 위 바텀 시트, 데스크톱은 지도 위 오버레이 (styles.css).
 * 위계: 이름 → 도보·평점·영업 → 카테고리·가격·강점 → 메뉴 → 행동 → 출처
 */
export function PlaceCard({ place, slotName, drawn, now, onClose, onRedraw, onShare }: Props) {
  const [menusOpen, setMenusOpen] = useState(false);
  const [heroFailed, setHeroFailed] = useState(false);

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
        <p className="eyebrow">고르는 중…</p>
        <h2 className="card-name" key={slotName}>
          {slotName}
        </h2>
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
    <div className="sheet" role="dialog" aria-labelledby="sheet-title" aria-live="polite">
      <div className="sheet-handle" aria-hidden="true" />
      <button type="button" className="sheet-close" aria-label="닫기" onClick={onClose}>
        ×
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
      {drawn && <p className="eyebrow">오늘은 여기 어때요?</p>}
      <h2 className="card-name" id="sheet-title">
        {place.name}
      </h2>
      <p className="facts">
        {walk && <b>{walk}</b>}
        <span>{ratingText(place)}</span>
        <span className={open.closed ? "closed" : undefined}>{open.text}</span>
      </p>
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
      <div className="actions">
        {drawn && (
          <button type="button" className="redraw" onClick={onRedraw}>
            다시 뽑기
          </button>
        )}
        <button type="button" className="primary" onClick={() => onShare(place)}>
          공유
        </button>
        <a href={place.url} target="_blank" rel="noreferrer">
          카카오맵
        </a>
      </div>
      <p className="source">정보 출처: 카카오맵</p>
    </div>
  );
}
