import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * R57 관리 화면 차트 — 차트 라이브러리 없이 SVG·CSS. 얇은 막대(최대 24px, 끝 4px 둥글게, 기준선은 각지게),
 * 2px 선, 막대 사이·쌓인 조각 사이 2px 틈, 흐린 1px 격자. 값 글자는 글자색 토큰만 쓰고 색은 표식이 맡는다.
 * 모든 표식은 가리키거나 키보드로 고르면 툴팁이 뜬다.
 */

type Tip = { x: number; y: number; body: ReactNode } | null;

/** 차트 영역 안에서 표식 위에 뜨는 툴팁 */
function useTip() {
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip>(null);
  const show = (el: Element, body: ReactNode) => {
    const b = box.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!b) return;
    setTip({ x: r.left + r.width / 2 - b.left, y: r.top - b.top, body });
  };
  const node = tip && (
    <div
      className="a-tip"
      role="status"
      style={{ "--x": `${tip.x}px`, "--y": `${tip.y}px` } as CSSProperties}
    >
      {tip.body}
    </div>
  );
  return { box, show, hide: () => setTip(null), node };
}

/** 0부터 깔끔한 눈금 3개 (최댓값보다 크거나 같은 1·2·5 × 10^n) */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

// ── 스파크라인 ─────────────────────────────

/** 14점 스파크라인: 2px 선 + 10% 면, 끝점 표시. 빈 날(null)은 선을 끊는다 */
export function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const w = 120;
  const h = 32;
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true" />;
  const max = Math.max(...nums);
  const min = Math.min(0, ...nums);
  const span = max - min || 1;
  const x = (i: number) => (values.length <= 1 ? w : (i / (values.length - 1)) * (w - 4) + 2);
  const y = (v: number) => h - 3 - ((v - min) / span) * (h - 8);
  const segs: string[] = [];
  let cur = "";
  values.forEach((v, i) => {
    if (v === null) {
      if (cur) segs.push(cur);
      cur = "";
      return;
    }
    cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (cur) segs.push(cur);
  const lastI = values.reduce<number>((acc, v, i) => (v === null ? acc : i), -1);
  const area = segs.map((d) => {
    const pts = d.slice(1).split(/[ML]/);
    const first = pts[0].split(",")[0];
    const last = pts[pts.length - 1].split(",")[0];
    return `${d}L${last},${h}L${first},${h}Z`;
  });
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="none">
      {area.map((d) => (
        <path key={d} d={d} className="spark-area" />
      ))}
      {segs.map((d) => (
        <path key={d} d={d} className="spark-line" vectorEffect="non-scaling-stroke" />
      ))}
      {lastI >= 0 && <circle cx={x(lastI)} cy={y(values[lastI] as number)} r={3} className="spark-dot" />}
    </svg>
  );
}

// ── 쌓인 세로 막대 (일별) ─────────────────────────────

export type Series = { key: string; name: string; className: string };
export type StackItem = { label: string; values: number[]; missing?: boolean; note?: string };

export function StackedColumns({ items, series, title }: { items: StackItem[]; series: Series[]; title: string }) {
  const t = useTip();
  const totals = items.map((d) => d.values.reduce((s, v) => s + v, 0));
  const top = niceMax(Math.max(0, ...totals));
  const ticks = [top, top / 2, 0];
  const every = items.length > 16 ? Math.ceil(items.length / 8) : items.length > 8 ? 2 : 1;
  const last = items.length - 1;
  /** 눈금 글자: every칸마다, 마지막 날은 언제나 (바로 앞 눈금과 겹치면 그 눈금을 뺀다) */
  const tickAt = (i: number) => i === last || (i % every === 0 && last - i >= (every === 1 ? 1 : Math.max(2, Math.ceil(every * 0.75))));
  const describe = (i: number) => (
    <>
      <strong>{items[i].label}</strong>
      {items[i].missing ? (
        <span>{items[i].note ?? "집계 전"}</span>
      ) : (
        series.map((s, k) => (
          <span key={s.key} className="a-tip-row">
            <i className={`key ${s.className}`} />
            {s.name} <b>{items[i].values[k].toLocaleString("ko-KR")}</b>
          </span>
        ))
      )}
    </>
  );
  return (
    <figure className="chart" aria-label={title}>
      <div className="legend" aria-hidden="true">
        {series.map((s) => (
          <span key={s.key}>
            <i className={`key ${s.className}`} />
            {s.name}
          </span>
        ))}
      </div>
      <div className="plot" ref={t.box} onMouseLeave={t.hide}>
        <div className="yaxis" aria-hidden="true">
          {ticks.map((v, i) => (
            <span key={v} style={{ top: `${i * 50}%` }}>
              {v.toLocaleString("ko-KR")}
            </span>
          ))}
          <span className="yaxis-sizer">{top.toLocaleString("ko-KR")}</span>
        </div>
        <div className="cols" style={{ "--n": items.length } as CSSProperties}>
          {items.map((d, i) => (
            <button
              key={d.label}
              type="button"
              className={`col${d.missing ? " is-missing" : ""}`}
              aria-label={`${d.label}: ${d.missing ? (d.note ?? "집계 전") : series.map((s, k) => `${s.name} ${d.values[k]}`).join(", ")}`}
              onMouseEnter={(e) => t.show(e.currentTarget.firstElementChild ?? e.currentTarget, describe(i))}
              onFocus={(e) => t.show(e.currentTarget.firstElementChild ?? e.currentTarget, describe(i))}
              onBlur={t.hide}
            >
              <span className="stack" style={{ height: `${(totals[i] / top) * 100}%` }}>
                {d.values.map((v, k) =>
                  v > 0 ? <span key={series[k].key} className={`cseg ${series[k].className}`} style={{ flexGrow: v }} /> : null,
                )}
              </span>
            </button>
          ))}
        </div>
        <span aria-hidden="true" />
        <div className="xaxis" style={{ "--n": items.length } as CSSProperties} aria-hidden="true">
          {items.map((d, i) => (
            <span key={d.label}>{tickAt(i) ? d.label : ""}</span>
          ))}
        </div>
        {t.node}
      </div>
    </figure>
  );
}

// ── 히트맵 (요일 × 시간) ─────────────────────────────

export function Heatmap({
  grid, rows, title, unit,
}: { grid: number[][]; rows: string[]; title: string; unit: string }) {
  const t = useTip();
  const max = Math.max(0, ...grid.flat());
  const level = (v: number) => (v <= 0 || max <= 0 ? 0 : Math.min(5, Math.ceil((v / max) * 5)));
  return (
    <figure className="chart" aria-label={title}>
      <div className="heat" ref={t.box} onMouseLeave={t.hide}>
        {grid.map((row, r) => (
          <div key={rows[r]} className="heat-row">
            <span className="heat-label">{rows[r]}</span>
            {row.map((v, h) => (
              <button
                key={h}
                type="button"
                className={`cell l${level(v)}`}
                aria-label={`${rows[r]}요일 ${h}시: ${unit} ${v}`}
                onMouseEnter={(e) =>
                  t.show(e.currentTarget, (
                    <>
                      <strong>
                        {rows[r]}요일 {h}시
                      </strong>
                      <span>
                        {unit} <b>{v.toLocaleString("ko-KR")}</b>
                      </span>
                    </>
                  ))
                }
                onFocus={(e) => t.show(e.currentTarget, `${rows[r]} ${h}시 · ${unit} ${v}`)}
                onBlur={t.hide}
              />
            ))}
          </div>
        ))}
        <div className="heat-row heat-axis" aria-hidden="true">
          <span className="heat-label" />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h}>{h % 6 === 0 ? h : ""}</span>
          ))}
        </div>
        {t.node}
      </div>
      <div className="heat-scale" aria-hidden="true">
        <span>적음</span>
        {[1, 2, 3, 4, 5].map((l) => (
          <i key={l} className={`cell l${l}`} />
        ))}
        <span>많음</span>
      </div>
    </figure>
  );
}

// ── 깔때기 ─────────────────────────────

export type FunnelStep = { label: string; value: number; detail?: string };

/** 단계마다 첫 단계 대비 너비, 이전 단계 대비 전환율과 이탈 수 */
export function Funnel({ steps }: { steps: FunnelStep[] }) {
  const first = steps[0]?.value ?? 0;
  return (
    <ol className="funnel">
      {steps.map((s, i) => {
        const prev = i > 0 ? steps[i - 1].value : null;
        const conv = prev ? s.value / prev : null;
        return (
          <li key={s.label}>
            <div className="funnel-head">
              <span className="funnel-label">
                <span className="funnel-n">{i + 1}</span>
                {s.label}
              </span>
              <span className="funnel-value">{s.value.toLocaleString("ko-KR")}</span>
            </div>
            <div className="funnel-track">
              <span className="funnel-bar" style={{ width: `${first > 0 ? Math.max(0.5, (s.value / first) * 100) : 0}%` }} />
            </div>
            <div className="funnel-sub">
              {conv !== null ? (
                <>
                  <span>이전 단계의 {Math.round(conv * 100)}%</span>
                  {prev !== null && prev - s.value > 0 && <span className="drop">이탈 {(prev - s.value).toLocaleString("ko-KR")}</span>}
                </>
              ) : (
                <span>시작</span>
              )}
              {s.detail && <span className="funnel-detail">{s.detail}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── 가로 막대 목록 ─────────────────────────────

export type BarItem = { key: string; label: ReactNode; value: number; sub?: string };

/** 순위·분포 목록: 이름 / 막대 / 값. 막대 길이는 가장 큰 값 기준 */
export function BarList({ items, total, empty = "기록이 없어요" }: { items: BarItem[]; total?: number; empty?: string }) {
  const max = Math.max(0, ...items.map((x) => x.value));
  if (items.length === 0 || max === 0) return <p className="empty-line">{empty}</p>;
  return (
    <ul className="barlist">
      {items.map((x) => (
        <li key={x.key}>
          <span className="barlist-label">{x.label}</span>
          <span className="barlist-track" aria-hidden="true">
            <span className="barlist-bar" style={{ width: `${(x.value / max) * 100}%` }} />
          </span>
          <span className="barlist-value">
            {x.value.toLocaleString("ko-KR")}
            {total ? <small>{Math.round((x.value / total) * 100)}%</small> : x.sub ? <small>{x.sub}</small> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── 게이지 ─────────────────────────────

/**
 * 하루 한도 게이지: 막대 = 한도 대비 사용량, 눈금 = 소프트 한도. 색 단계는 소프트 한도 대비(50/70/90 %)
 */
export function Meter({
  value, limit, soft, level, label,
}: { value: number; limit: number; soft: number; level: string; label: string }) {
  const id = useId();
  const share = Math.min(1, value / limit);
  const softAt = Math.min(1, soft / limit);
  return (
    <div className="meter-wrap">
      <div
        className="meter2"
        role="meter"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={value}
        aria-valuetext={`${value.toLocaleString("ko-KR")} / ${limit.toLocaleString("ko-KR")}`}
      >
        <span className={`meter2-fill lv-${level}`} style={{ width: `${share * 100}%` }} />
        <span className="meter2-soft" style={{ left: `${softAt * 100}%` }} title="소프트 한도" />
      </div>
      <span id={id} className="sr-only">
        {label}
      </span>
    </div>
  );
}
