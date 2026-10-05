import type { CSSProperties } from "react";
import { FILTER_GROUPS, GROUP_LABEL } from "../../shared/category";
import { MAX_RADIUS, MIN_RADIUS, RADIUS_STEP } from "../../shared/constants";
import { walkMinutes } from "../../shared/geo";
import type { Filters, MinRating, Party, PriceCap } from "../../shared/recommend";
import type { CategoryGroup } from "../../shared/types";
import { detailSummary } from "../format";

const PARTY: { v: Party; label: string }[] = [1, 2, 3, 4].map((v) => ({ v: v as Party, label: v === 4 ? "4명+" : `${v}명` }));
const PRICE: { v: PriceCap; label: string }[] = [
  { v: "all", label: "전체" },
  { v: 10000, label: "1만 이하" },
  { v: 15000, label: "1.5만 이하" },
  { v: 20000, label: "2만 이하" },
];
const RATING: { v: MinRating; label: string }[] = [
  { v: 0, label: "무관" },
  { v: 3.5, label: "3.5+" },
  { v: 4, label: "4.0+" },
];

type Props = { filters: Filters; onChange: (f: Filters) => void };

type Option<T> = { v: T; label: string };

/** iOS식 세그먼트: 트랙 하나 안에서 흰 선택 표시가 미끄러진다 */
function Segmented<T extends string | number | null>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: Option<T>[];
  value: T;
  onPick: (v: T) => void;
}) {
  const index = options.findIndex((o) => o.v === value);
  const style = { "--n": options.length, "--i": Math.max(index, 0) } as CSSProperties;
  return (
    <div className="seg" role="group" aria-label={label} style={style}>
      {index >= 0 && <span className="seg-thumb" aria-hidden="true" />}
      {options.map((o) => (
        <button key={String(o.v)} type="button" aria-pressed={o.v === value} onClick={() => onPick(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 항상 보이는 것: 반경, 인원, 카테고리. 나머지는 "상세 조건"에 접는다. */
export function FilterPanel({ filters: f, onChange }: Props) {
  const set = (patch: Partial<Filters>) => onChange({ ...f, ...patch });
  const toggleGroup = (g: CategoryGroup) =>
    set({ groups: f.groups.includes(g) ? f.groups.filter((x) => x !== g) : [...f.groups, g] });

  return (
    <div className="filters">
      <section className="field">
        <div className="field-head">
          <span>거리</span>
          <span className="hint" aria-live="polite">
            반경 {f.radius}m · 도보 약 {walkMinutes(f.radius)}분
          </span>
        </div>
        <input
          type="range"
          min={MIN_RADIUS}
          max={MAX_RADIUS}
          step={RADIUS_STEP}
          value={f.radius}
          aria-label="반경"
          aria-valuetext={`반경 ${f.radius}미터, 도보 약 ${walkMinutes(f.radius)}분`}
          onChange={(e) => set({ radius: Number(e.target.value) })}
        />
      </section>

      <section className="field">
        <div className="field-head">
          <span>인원</span>
        </div>
        <Segmented label="인원" options={PARTY} value={f.party} onPick={(p) => set({ party: p })} />
      </section>

      <section className="field">
        <div className="field-head">
          <span>카테고리</span>
          <span className="hint">{f.groups.length > 0 ? `${f.groups.length}개 선택` : "전체"}</span>
        </div>
        <div className="chips" role="group" aria-label="카테고리">
          <button type="button" className="chip" aria-pressed={f.groups.length === 0} onClick={() => set({ groups: [] })}>
            전체
          </button>
          {FILTER_GROUPS.map((g) => (
            <button key={g} type="button" className="chip" aria-pressed={f.groups.includes(g)} onClick={() => toggleGroup(g)}>
              {GROUP_LABEL[g as Exclude<CategoryGroup, "dessert">]}
            </button>
          ))}
        </div>
      </section>

      <details className="more">
        <summary>
          <span className="more-title">상세 조건</span>
          <span className="more-summary">{detailSummary(f)}</span>
        </summary>
        <div className="more-body">
          <section className="field">
            <div className="field-head">
              <span>1인 예산</span>
            </div>
            <Segmented label="1인 예산" options={PRICE} value={f.priceCap} onPick={(v) => set({ priceCap: v })} />
          </section>
          <section className="field">
            <div className="field-head">
              <span>최소 평점</span>
            </div>
            <Segmented label="최소 평점" options={RATING} value={f.minRating} onPick={(v) => set({ minRating: v })} />
          </section>
          <label className="switch">
            <span>지금 영업 중인 곳만</span>
            <input type="checkbox" checked={f.openOnly} onChange={(e) => set({ openOnly: e.target.checked })} />
            <span className="switch-track" aria-hidden="true" />
          </label>
          <label className="switch">
            <span>술집 포함</span>
            <input type="checkbox" checked={f.includeBar} onChange={(e) => set({ includeBar: e.target.checked })} />
            <span className="switch-track" aria-hidden="true" />
          </label>
        </div>
      </details>
    </div>
  );
}
