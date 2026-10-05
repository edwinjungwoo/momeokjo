import { useState } from "react";
import { lastLevel } from "../../shared/category";
import { photoThumbUrl } from "../../shared/photo";
import type { SortKey } from "../../shared/recommend";
import type { ApiPlace } from "../../shared/types";
import { openState, priceText } from "../format";
import { RankPill } from "./RankPill";
import { Rating } from "./Rating";

type Props = {
  places: ApiPlace[];
  selectedId: string | null;
  /** R34: id → 근처 상위 N% */
  ranks: ReadonlyMap<string, number>;
  sort: SortKey;
  now: Date;
  dim: boolean;
  onSort: (s: SortKey) => void;
  onSelect: (p: ApiPlace) => void;
};

/** R33: 64px 썸네일. 사진이 없거나 로드에 실패하면 크림색 자리 + 흐린 마스코트로 바꿔서 줄 정렬을 유지한다 */
function Thumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <span className="row-thumb is-empty" aria-hidden="true" />;
  return (
    <img
      className="row-thumb"
      src={photoThumbUrl(url)}
      alt=""
      width={64}
      height={64}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** R20: 후보 목록과 정렬 */
export function PlaceList({
  places,
  selectedId,
  ranks,
  sort,
  now,
  dim,
  onSort,
  onSelect,
}: Props) {
  // 사진 있는 가게가 하나라도 있으면 모든 행에 썸네일 칸을 둬서(없으면 크림색 자리) 글자 줄을 맞춘다
  const anyPhoto = places.some((p) => p.photoUrl);
  return (
    <section className="field" aria-label="후보 목록">
      <div className="list-head">
        <h2 className="list-title">
          후보 <em>{places.length}</em>곳
        </h2>
        <select
          className="sort"
          value={sort}
          aria-label="정렬"
          onChange={(e) => onSort(e.target.value as SortKey)}
        >
          <option value="distance">거리순</option>
          <option value="rating">평점순</option>
          <option value="price">가격순</option>
        </select>
      </div>
      <ul className={`list${dim ? " is-dim" : ""}`}>
        {places.map((p) => {
          const price = priceText(p);
          const open = openState(p, now);
          const category = lastLevel(p.category);
          return (
            <li key={p.id}>
              <button type="button" className="row" aria-current={p.id === selectedId} onClick={() => onSelect(p)}>
                {anyPhoto && <Thumb url={p.photoUrl} />}
                <span className="row-text">
                  <span className="row-name">{p.name}</span>
                  <span className="row-sub">
                    {/* "영업 중"은 기본값이라 생략하고, 곧 닫거나 닫힌 경우만 앞에 알린다 */}
                    {open.closed && <span className="row-warn">{open.text}</span>}
                    <Rating p={p} />
                    {category && <span className="row-cat">{category}</span>}
                    <RankPill top={ranks.get(p.id)} />
                  </span>
                </span>
                <span className="row-side">
                  {p.walkMinutes !== undefined && <span className="row-walk">도보 {p.walkMinutes}분</span>}
                  {price && <span className="row-price">1인 {price}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
