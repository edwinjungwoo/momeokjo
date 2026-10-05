import { useState } from "react";
import { lastLevel } from "../../shared/category";
import { photoThumbUrl } from "../../shared/photo";
import type { SortKey } from "../../shared/recommend";
import type { ApiPlace } from "../../shared/types";
import { openState, priceText, walkText, type OpenState } from "../format";

type Props = {
  places: ApiPlace[];
  selectedId: string | null;
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
      src={photoThumbUrl(url, 320)}
      alt=""
      width={64}
      height={64}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/** 영업 상태 알약. 정보가 없으면 줄을 비워 둔다 */
function OpenPill({ open }: { open: OpenState }) {
  if (open.kind === "unknown") return null;
  return <span className={`pill${open.kind === "open" ? " is-open" : ""}`}>{open.text}</span>;
}

function Rating({ p }: { p: ApiPlace }) {
  const r = p.detail?.rating ?? null;
  if (r === null) return <span className="row-rating is-none">평점 정보 없음</span>;
  return (
    <span className="row-rating">
      <span aria-hidden="true">⭐</span> <b>{r.toFixed(1)}</b> ({(p.detail?.reviewCount ?? 0).toLocaleString("ko-KR")})
    </span>
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
          const meta = [lastLevel(p.category), walkText(p), price && `1인 ${price}`].filter(Boolean).join(" · ");
          return (
            <li key={p.id}>
              <button type="button" className="row" aria-current={p.id === selectedId} onClick={() => onSelect(p)}>
                {anyPhoto && <Thumb url={p.photoUrl} />}
                <span className="row-text">
                  <span className="row-head">
                    <span className="row-name">{p.name}</span>
                    <OpenPill open={openState(p, now)} />
                  </span>
                  <Rating p={p} />
                  {meta && <span className="row-meta">{meta}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
