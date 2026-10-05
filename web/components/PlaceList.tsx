import { useState } from "react";
import { lastLevel } from "../../shared/category";
import { photoThumbUrl } from "../../shared/photo";
import type { SortKey } from "../../shared/recommend";
import type { ApiPlace } from "../../shared/types";
import { openState, priceText, ratingShort, walkText } from "../format";

type Props = {
  places: ApiPlace[];
  selectedId: string | null;
  sort: SortKey;
  now: Date;
  dim: boolean;
  onSort: (s: SortKey) => void;
  onSelect: (p: ApiPlace) => void;
};

/** R33: 56px 썸네일. 로드에 실패하면 중립 박스로 바꿔서 줄 정렬을 유지한다 */
function Thumb({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <span className="row-thumb" aria-hidden="true" />;
  return (
    <img
      className="row-thumb"
      src={photoThumbUrl(url, 320)}
      alt=""
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
  sort,
  now,
  dim,
  onSort,
  onSelect,
}: Props) {
  // 사진 있는 가게가 하나라도 있으면 모든 행에 썸네일 칸을 둬서(없으면 중립 박스) 글자 줄을 맞춘다
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
          const open = openState(p, now);
          const walk = walkText(p);
          const meta = [lastLevel(p.category), ratingShort(p), priceText(p)]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={p.id}>
              <button
                type="button"
                className="row"
                aria-current={p.id === selectedId}
                onClick={() => onSelect(p)}
              >
                {anyPhoto && <Thumb url={p.photoUrl} />}
                <span className="row-text">
                  <span className="row-head">
                    <span className="row-name">{p.name}</span>
                    {walk && <span className="row-walk">{walk}</span>}
                  </span>
                  <span className="row-meta">
                    {meta && `${meta} · `}
                    <span className={open.closed ? "closed" : undefined}>
                      {open.text}
                    </span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
