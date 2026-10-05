import { FILTER_GROUPS, GROUP_LABEL } from "../../shared/category";
import { MAX_RADIUS, MIN_RADIUS } from "../../shared/constants";
import { withLunch, withRadius, type Filters, type MinRating, type Party, type PriceCap } from "../../shared/recommend";
import type { CategoryGroup, LunchMinutes } from "../../shared/types";
import { detailSummary } from "../format";

const LUNCH: LunchMinutes[] = [30, 60, 90];
const PARTY: Party[] = [1, 2, 3, 4];
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

/** 항상 보이는 것: 점심시간, 인원, 카테고리. 나머지는 "상세 조건"에 접는다. */
export function FilterPanel({ filters: f, onChange }: Props) {
  const set = (patch: Partial<Filters>) => onChange({ ...f, ...patch });
  const toggleGroup = (g: CategoryGroup) =>
    set({ groups: f.groups.includes(g) ? f.groups.filter((x) => x !== g) : [...f.groups, g] });

  return (
    <div className="filters">
      <section className="field">
        <div className="field-head">
          <span>점심시간</span>
          <span className="hint">{f.lunch ? `도보 반경 ${f.radius}m` : `직접 설정 · 반경 ${f.radius}m`}</span>
        </div>
        <div className="seg" role="group" aria-label="점심시간">
          {LUNCH.map((l) => (
            <button key={l} type="button" aria-pressed={f.lunch === l} onClick={() => onChange(withLunch(f, l))}>
              {l}분
            </button>
          ))}
        </div>
      </section>

      <section className="field">
        <div className="field-head">
          <span>인원</span>
        </div>
        <div className="seg" role="group" aria-label="인원">
          {PARTY.map((p) => (
            <button key={p} type="button" aria-pressed={f.party === p} onClick={() => set({ party: p })}>
              {p === 4 ? "4명+" : `${p}명`}
            </button>
          ))}
        </div>
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
            <div className="seg" role="group" aria-label="1인 예산">
              {PRICE.map((p) => (
                <button key={String(p.v)} type="button" aria-pressed={f.priceCap === p.v} onClick={() => set({ priceCap: p.v })}>
                  {p.label}
                </button>
              ))}
            </div>
          </section>
          <section className="field">
            <div className="field-head">
              <span>최소 평점</span>
            </div>
            <div className="seg" role="group" aria-label="최소 평점">
              {RATING.map((r) => (
                <button key={r.v} type="button" aria-pressed={f.minRating === r.v} onClick={() => set({ minRating: r.v })}>
                  {r.label}
                </button>
              ))}
            </div>
          </section>
          <section className="field">
            <div className="field-head">
              <span>반경 직접 정하기</span>
              <span className="hint">{f.radius}m</span>
            </div>
            <input
              type="range"
              min={MIN_RADIUS}
              max={MAX_RADIUS}
              step={50}
              value={f.radius}
              aria-label="반경"
              onChange={(e) => onChange(withRadius(f, Number(e.target.value)))}
            />
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
