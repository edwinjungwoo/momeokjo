import { useEffect, useRef, useState } from "react";
import { lastLevel } from "../../shared/category";
import { photoThumbUrl } from "../../shared/photo";
import type { ApiPlace } from "../../shared/types";
import { openState, priceText, todayHoursText, won } from "../format";
import { ChevronDown, CloseIcon } from "./Icons";
import { Mascot } from "./Mascot";
import { RankPill } from "./RankPill";
import { useSwipeDown } from "./useSwipeDown";

type Props = {
  /** 셔플 중이면 지금 보여줄 이름, 아니면 null */
  slotName: string | null;
  /** 보여줄 후보 (최대 3곳, 순서 = 지도 번호) */
  places: ApiPlace[];
  /** 공유 링크로 받은 후보면 true */
  received: boolean;
  /** 펼친 카드 id (지도에서 그 핀을 강조한다) */
  focusId: string | null;
  /** 펼친 카드의 전체 상세를 받는 중 */
  detailLoading: boolean;
  ranks: ReadonlyMap<string, number>;
  /** R41 완화로 들어온 곳 ("조건 밖" 표시) */
  outside?: ReadonlySet<string>;
  now: Date;
  onFocus: (id: string | null) => void;
  onClose: () => void;
  onShare: (places: ApiPlace[]) => void;
  onKakao: (p: ApiPlace) => void;
  onExclude: (p: ApiPlace) => void;
};

/** 56px 썸네일 + 왼쪽 위 번호 (지도 핀 번호와 같다). 사진이 없으면 크림색 자리 + 흐린 마스코트 */
function Thumb({ url, rank }: { url: string | null; rank: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`trio-thumb${!url || failed ? " is-empty" : ""}`} aria-hidden="true">
      {url && !failed && (
        <img src={photoThumbUrl(url, 320)} alt="" width={56} height={56} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      )}
      <span className="trio-rank">{rank}</span>
    </span>
  );
}

function TrioCard(props: {
  place: ApiPlace;
  rank: number;
  open: boolean;
  detailLoading: boolean;
  topPercent: number | undefined;
  outside: boolean;
  now: Date;
  onToggle: () => void;
  onKakao: (p: ApiPlace) => void;
  onExclude: (p: ApiPlace) => void;
}) {
  const { place: p, rank, open, detailLoading, topPercent, outside, now, onToggle, onKakao, onExclude } = props;
  const li = useRef<HTMLLIElement>(null);
  const d = p.detail;
  const rating = d?.rating ?? null;
  const price = priceText(p);
  const sub = [lastLevel(p.category), price ? `1인 ${price}` : null].filter(Boolean).join(" · ");
  const state = openState(p, now);
  const hours = todayHoursText(p, now);
  const menus = d?.menus ?? [];
  const detailId = `trio-detail-${p.id}`;

  // 펼치면 시트 안에서 그 카드가 보이게 한다
  useEffect(() => {
    if (open) li.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);

  return (
    <li ref={li} className={`trio-card${open ? " is-open" : ""}`}>
      <button type="button" className="trio-row" id={`trio-row-${p.id}`}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={onToggle}
      >
        <Thumb url={p.photoUrl} rank={rank} />
        <span className="trio-text">
          <span className="trio-name">
            <span className="sr-only">{rank}번째 후보 </span>
            {p.name}
          </span>
          <span className="trio-facts">
            {p.walkMinutes !== undefined && <b>도보 {p.walkMinutes}분</b>}
            {rating !== null && (
              <span className="trio-rating">
                <span className="star" aria-hidden="true">★</span>
                {rating.toFixed(1)}
              </span>
            )}
            {state.closed && <span className="closed">{state.text}</span>}
            <RankPill top={topPercent} />
          </span>
          {(sub || outside) && (
            <span className="trio-sub">
              {outside && <span className="trio-outside">조건 밖</span>}
              {sub}
            </span>
          )}
        </span>
        <ChevronDown className="trio-chev" size={14} />
      </button>
      {open && (
        <div className="trio-detail" id={detailId}>
          <p className="trio-line">
            <span className={state.closed ? "closed" : undefined}>{state.text}</span>
            {hours && <span>{hours}</span>}
            {d && d.reviewCount !== null && rating !== null && <span>리뷰 {d.reviewCount.toLocaleString("ko-KR")}</span>}
          </p>
          {d && d.strengths.length > 0 && <p className="trio-line">{d.strengths.join(", ")}</p>}
          {!d && !detailLoading && <p className="trio-line">평점과 메뉴 정보를 아직 불러오지 못했어요</p>}
          {menus.length > 0 && (
            <ul className="menus trio-menus is-open">
              {menus.map((m, i) => (
                <li key={`${m.name}-${i}`}>
                  <span>{m.name}</span>
                  <span>{won(m.price)}</span>
                </li>
              ))}
            </ul>
          )}
          {detailLoading && <p className="trio-line is-loading">메뉴를 불러오는 중이에요…</p>}
          <div className="trio-links">
            <a href={p.url} target="_blank" rel="noreferrer" onClick={() => onKakao(p)}>
              카카오맵에서 보기
            </a>
            <button type="button" className="trio-hide" onClick={() => onExclude(p)}>
              여긴 빼줘
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * R22′: 뽑기 결과 3곳. 셔플 중에는 이름이 바뀌는 자리만 보여주고, 멈추면 작은 카드 3장이 쌓인다.
 * 카드를 누르면 그 자리에서 펼쳐(아코디언) 메뉴·영업시간·카카오맵·"여긴 빼줘"를 보여준다.
 * 아래 행동: 공유(3곳 모두, 주 행동) · 다시 뽑기(보조. 모바일은 바로 아래 뽑기 바가 대신한다)
 */
export function TrioSheet(props: Props) {
  const { slotName, places, received, focusId, detailLoading, ranks, outside, now } = props;
  const { onFocus, onClose, onShare, onKakao } = props;
  const shuffling = slotName !== null;
  const swipe = useSwipeDown(onClose);
  const closeBtn = useRef<HTMLButtonElement>(null);

  // 셔플 중에는 Esc로 닫지 않는다 (M2)
  useEffect(() => {
    if (shuffling) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, shuffling]);

  const firstId = places[0]?.id;
  useEffect(() => {
    if (!shuffling && firstId) closeBtn.current?.focus({ preventScroll: true });
  }, [shuffling, firstId]);

  // "여긴 빼줘" 뒤: 눌렀던 버튼이 사라지므로 다음 카드(없으면 제목)로 포커스를 옮긴다
  const afterExclude = useRef<string | null>(null);
  const onExclude = (p: ApiPlace) => {
    const next = places[places.findIndex((x) => x.id === p.id) + 1];
    afterExclude.current = next ? `trio-row-${next.id}` : "trio-title";
    props.onExclude(p);
  };
  useEffect(() => {
    const target = afterExclude.current;
    if (!target || shuffling) return;
    afterExclude.current = null;
    document.getElementById(target)?.focus({ preventScroll: false });
  });

  if (shuffling) {
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
  if (places.length === 0) return null;

  const title = received ? `공유받은 후보 ${places.length}곳` : `모먹죠가 고른 ${places.length}곳`;
  return (
    <div className="sheet trio" role="dialog" aria-labelledby="trio-title" ref={swipe.sheet}>
      <div className="sheet-grab" aria-hidden="true" {...swipe.grab}>
        <div className="sheet-handle" />
      </div>
      <button type="button" className="sheet-close" aria-label="닫기" ref={closeBtn} onClick={onClose}>
        <CloseIcon />
      </button>
      <div className="trio-head">
        <Mascot pose="thumbsup" height={44} eager />
        <div className="trio-head-text">
          <h2 className="trio-title" id="trio-title" tabIndex={-1}>
            {title}
          </h2>
          <p className="trio-hint">눌러서 메뉴와 영업시간을 볼 수 있어요</p>
        </div>
      </div>
      <ol className="trio-list">
        {places.map((p, i) => (
          <TrioCard
            key={p.id}
            place={p}
            rank={i + 1}
            open={p.id === focusId}
            detailLoading={p.id === focusId && detailLoading}
            topPercent={ranks.get(p.id)}
            outside={outside?.has(p.id) ?? false}
            now={now}
            onToggle={() => onFocus(p.id === focusId ? null : p.id)}
            onKakao={onKakao}
            onExclude={onExclude}
          />
        ))}
      </ol>
      <div className="sheet-foot">
        <div className="actions">
          <button type="button" className="primary" onClick={() => onShare(places)}>
            공유
          </button>
        </div>
        <p className="source">정보 출처: 카카오맵</p>
      </div>
    </div>
  );
}
