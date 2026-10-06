import type { CSSProperties } from "react";
import { GROUP_LABEL } from "../../shared/category";
import {
  COLLECT_SINCE, DECIDE_METRICS, REASONS_TRACKED, RETENTION_DAYS, deltaOf, histogramMedian, ratio, type BehaviorData, type Metrics,
  type TopPlace,
} from "../../shared/dashboard";
import { BarList, Funnel, type BarItem } from "./charts";
import { delta, duration, num, pct, shortDay } from "./format";
import { EmptyState, SourceNote } from "./Overview";

const v = (t: Metrics, k: string) => t[k] ?? 0;

/** 데이터가 아직 없으면 "수집 시작: 날짜" */
function Since({ date }: { date: string }) {
  return <span className="since">수집 시작: {date}</span>;
}

function Rate({ label, value, prev, hint }: { label: string; value: number | null; prev?: number | null; hint?: string }) {
  const d = prev === undefined ? null : deltaOf(value, prev);
  return (
    <div className="rate">
      <p className="rate-label">{label}</p>
      <p className="rate-value">
        {pct(value)}
        {d !== null && <span className={`delta ${d > 0 ? "up" : d < 0 ? "down" : "flat"}`}>{delta(d)}</span>}
      </p>
      {hint && <p className="muted small">{hint}</p>}
    </div>
  );
}

function PlaceList({ title, items, empty }: { title: string; items: TopPlace[]; empty: string }) {
  return (
    <section className="card">
      <h3 className="sub-title">{title}</h3>
      <BarList
        empty={empty}
        items={items.map((p, i) => ({
          key: p.placeId,
          label: (
            <>
              <span className="rank-no">{i + 1}</span>
              <a href={`https://place.map.kakao.com/${p.placeId}`} target="_blank" rel="noreferrer">
                {p.name ?? `#${p.placeId}`}
              </a>
            </>
          ),
          value: p.count,
        }))}
      />
    </section>
  );
}

const PARTY = [1, 2, 3, 4].map((n) => ({ key: `f_party_${n}`, label: n === 4 ? "4명+" : `${n}명` }));
const PRICE = [
  { key: "f_price_all", label: "전체" },
  { key: "f_price_10000", label: "1만 이하" },
  { key: "f_price_15000", label: "1.5만 이하" },
  { key: "f_price_20000", label: "2만 이하" },
];
const RATING = [
  { key: "f_rating_0", label: "무관" },
  { key: "f_rating_3.5", label: "3.5+" },
  { key: "f_rating_4", label: "4.0+" },
];
const OPEN = [
  { key: "f_open_1", label: "영업 중만" },
  { key: "f_open_0", label: "상관없음" },
];
const RADIUS = [
  { key: "f_radius_300", label: "~300m" },
  { key: "f_radius_500", label: "~500m" },
  { key: "f_radius_700", label: "~700m" },
  { key: "f_radius_1000", label: "~1km" },
];
const GROUPS = [
  { key: "f_group_all", label: "전체(안 고름)" },
  ...Object.entries(GROUP_LABEL).map(([g, label]) => ({ key: `f_group_${g}`, label })),
];

function Dist({ title, t, rows }: { title: string; t: Metrics; rows: { key: string; label: string }[] }) {
  const items: BarItem[] = rows.map((r) => ({ key: r.key, label: r.label, value: v(t, r.key) }));
  return (
    <div className="dist">
      <h4 className="mini-title">{title}</h4>
      <BarList items={items} total={v(t, "f_total") || undefined} empty="기록 없음" />
    </div>
  );
}

function CohortGrid({ data }: { data: BehaviorData }) {
  if (data.cohorts.length === 0) {
    return <p className="empty-line">첫 방문 기록이 쌓이면(매일 새벽 4시 집계) 주별 재방문이 보여요.</p>;
  }
  return (
    <div className="cohort-wrap">
      <table className="cohort">
        <thead>
          <tr>
            <th>첫 방문 주</th>
            <th className="num">인원</th>
            {RETENTION_DAYS.map((n) => (
              <th key={n} className="num" title={`D${n}: 첫 방문일 + ${n}일 이후(그날 포함) 한 번이라도 다시 연 비율 — 기간 끝은 정하지 않아요`}>
                D{n}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.cohorts.map((c) => (
            <tr key={c.week}>
              <td>{shortDay(c.week)} 주</td>
              <td className="num">{num(c.size)}</td>
              {c.ret.map((r, i) => {
                const share = r === null || c.size === 0 ? null : r / c.size;
                const partial = c.partial?.[i] === true;
                return (
                  <td
                    key={RETENTION_DAYS[i]}
                    className={`num ret${share === null ? " is-na" : ""}${partial ? " is-partial" : ""}`}
                    style={share === null ? undefined : ({ "--a": Math.max(0.06, share) } as CSSProperties)}
                    title={
                      share === null
                        ? "아직 관찰할 수 없어요"
                        : `${r}명 / ${c.size}명${partial ? " — 이 주의 뒷날 방문자는 아직 D" + RETENTION_DAYS[i] + "이 안 지나 일부만 관찰했어요" : ""}`
                    }
                  >
                    {share === null ? "·" : `${pct(share)}${partial ? "*" : ""}`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Dn = 첫 방문일 + n일 이후(그날 포함) 한 번이라도 다시 앱을 연 비율(기간 끝 없음). 점(·)은 아직 그만큼 지나지 않은 칸, 별(*)은 그 주의 일부
        방문자만 관찰한 칸이에요.
      </p>
    </div>
  );
}

export function Behavior({ data }: { data: BehaviorData }) {
  const t = data.totals;
  const p = data.prevTotals;
  if (v(t, "sessions") === 0 && v(t, "events") === 0) {
    return (
      <div className="stack-lg">
        <SourceNote sources={data.sources} />
        <EmptyState title="이 기간에는 아직 행동 기록이 없어요" body="세션이 생기면 깔때기·재방문·선택 분포가 채워져요." />
        <section className="card">
          <h2 className="sec-title">재방문 코호트</h2>
          <CohortGrid data={data} />
        </section>
      </div>
    );
  }
  const decideCounts = DECIDE_METRICS.map((m) => v(t, m));
  const median = histogramMedian(decideCounts);
  const autoS = v(t, "auto_sessions");
  const drawSessions = ["redraws_0", "redraws_1", "redraws_2", "redraws_3p"].reduce((s, k) => s + v(t, k), 0);
  const conv = (tt: Metrics | null) => (tt ? ratio(v(tt, "funnel_decide"), v(tt, "sessions")) : null);
  const ranks = [1, 2, 3];
  const draws = v(t, "draw_manual") + v(t, "redraw") + v(t, "draw_auto");
  return (
    <div className="stack-lg">
      <SourceNote sources={data.sources} />
      <div className="grid-2">
        <section className="card">
          <div className="a-card-head">
            <h2 className="sec-title">결정 깔때기</h2>
            <span className="muted small">세션 기준, 단계마다 앞 단계를 거친 세션만</span>
          </div>
          <Funnel
            steps={[
              { label: "앱 열기", value: v(t, "sessions") },
              {
                label: "뽑기",
                value: v(t, "funnel_draw"),
                detail: `직접 ${num(v(t, "funnel_draw_manual"))} · 자동만 ${num(v(t, "funnel_draw_auto_only"))}`,
              },
              { label: "카드 펼침", value: v(t, "funnel_expand") },
              {
                label: "결정",
                value: v(t, "funnel_decide"),
                detail: `공유 ${num(v(t, "funnel_share"))} · 카카오맵 ${num(v(t, "funnel_kakao"))} · 여기로 가요 ${num(v(t, "funnel_confirm"))}`,
              },
            ]}
          />
          <div className="rates">
            <Rate label="열기 → 결정 (깔때기 끝까지)" value={conv(t)} prev={p ? conv(p) : undefined} />
            <Rate
              label="결정률 (펼침 없이 결정 포함)"
              value={ratio(v(t, "decided"), v(t, "sessions"))}
              prev={p ? ratio(v(p, "decided"), v(p, "sessions")) : undefined}
            />
          </div>
        </section>

        <section className="card">
          <div className="a-card-head">
            <h2 className="sec-title">재방문 코호트</h2>
            <span className="muted small">첫 방문 주(월요일 시작)별</span>
          </div>
          <CohortGrid data={data} />
        </section>
      </div>

      <section className="card">
        <h2 className="sec-title">결정하는 모습</h2>
        <div className="grid-3">
          <div>
            <h3 className="sub-title">다시 뽑기 횟수</h3>
            <BarList
              total={drawSessions || undefined}
              items={[
                { key: "0", label: "0번", value: v(t, "redraws_0") },
                { key: "1", label: "1번", value: v(t, "redraws_1") },
                { key: "2", label: "2번", value: v(t, "redraws_2") },
                { key: "3", label: "3번+", value: v(t, "redraws_3p") },
              ]}
            />
            <p className="muted small">뽑기가 있는 세션 {num(drawSessions)}개 중</p>
          </div>
          <div>
            <h3 className="sub-title">
              결정까지 걸린 시간 <span className="stat-inline">중앙값 {duration(median)}</span>
            </h3>
            <BarList
              total={decideCounts.reduce((s, x) => s + x, 0) || undefined}
              items={["~10초", "10~30초", "30초~1분", "1~2분", "2~5분", "5~15분", "15분+"].map((label, i) => ({
                key: label,
                label,
                value: decideCounts[i],
              }))}
            />
            <p className="muted small">첫 뽑기 → 첫 결정(공유·카카오맵). 중앙값은 구간 안 보간</p>
          </div>
          <div>
            <h3 className="sub-title">자동 뽑기 수용</h3>
            <div className="split" role="img" aria-label="자동 뽑기 뒤: 결정, 다시 뽑음, 그냥 떠남">
              {(
                [
                  ["auto_accepted", "s-accept"],
                  ["auto_redrawn", "s-redraw"],
                  ["auto_left", "s-left"],
                ] as const
              ).map(([k, cls]) => (v(t, k) > 0 ? <span key={k} className={cls} style={{ flexGrow: v(t, k) }} /> : null))}
            </div>
            <ul className="split-legend">
              <li>
                <i className="key s-accept" /> 그대로 결정 <b>{pct(ratio(v(t, "auto_accepted"), autoS))}</b>
              </li>
              <li>
                <i className="key s-redraw" /> 다시 뽑음 <b>{pct(ratio(v(t, "auto_redrawn"), autoS))}</b>
              </li>
              <li>
                <i className="key s-left" /> 그냥 떠남 <b>{pct(ratio(v(t, "auto_left"), autoS))}</b>
              </li>
            </ul>
            <p className="muted small">자동 뽑기가 있는 세션 {num(autoS)}개. "닫기"는 따로 보내지 않아 결정도 다시 뽑기도 없으면 떠남으로 봐요.</p>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="sec-title">무엇을 고르나</h2>
        <div className="grid-2">
          <div>
            <h3 className="sub-title">결과 카드 번호별</h3>
            <table className="rtable compact">
              <thead>
                <tr>
                  <th>카드</th>
                  <th className="num">펼침</th>
                  <th className="num">카카오맵</th>
                  <th className="num">여기로 가요</th>
                  <th className="num">빼줘</th>
                </tr>
              </thead>
              <tbody>
                {ranks.map((r) => (
                  <tr key={r}>
                    <td className="name">{r}번</td>
                    <td className="num" data-label="펼침">{num(v(t, `expand_r${r}`))}</td>
                    <td className="num" data-label="카카오맵">{num(v(t, `kakao_r${r}`))}</td>
                    <td className="num" data-label="여기로 가요">
                      {v(t, "share_confirm") > 0 && ranks.every((x) => v(t, `confirm_r${x}`) === 0) ? (
                        <Since date={COLLECT_SINCE.confirmRank} />
                      ) : (
                        num(v(t, `confirm_r${r}`))
                      )}
                    </td>
                    <td className="num" data-label="빼줘">{num(v(t, `exclude_r${r}`))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="kv">
              <span>"왜" 한 단어(R46)와 선택률</span>
              <span className="muted">{REASONS_TRACKED ? "" : "데이터 없음 — 이유 라벨은 보내지 않아요"}</span>
            </div>
            <div className="kv">
              <span>후보 0곳이 된 필터 변경</span>
              <b>
                {pct(ratio(v(t, "empty_result"), v(t, "filter_change")))}{" "}
                <small className="muted">
                  ({num(v(t, "empty_result"))} / {num(v(t, "filter_change"))})
                </small>
              </b>
            </div>
            <div className="kv">
              <span>완화(R41)가 섞인 뽑기</span>
              {v(t, "draw_relaxed") === 0 ? (
                <Since date={COLLECT_SINCE.relaxed} />
              ) : (
                <b>
                  {pct(ratio(v(t, "draw_relaxed"), draws))} <small className="muted">({num(v(t, "draw_relaxed"))})</small>
                </b>
              )}
            </div>
          </div>
          <div>
            <h3 className="sub-title">
              필터 사용 분포 <span className="muted small">바꾼 뒤 스냅숏 {num(v(t, "f_total"))}번 기준</span>
            </h3>
            <div className="dist-grid">
              <Dist title="인원" t={t} rows={PARTY} />
              <Dist title="반경" t={t} rows={RADIUS} />
              <Dist title="예산" t={t} rows={PRICE} />
              <Dist title="평점" t={t} rows={RATING} />
              <Dist title="영업 중" t={t} rows={OPEN} />
              <Dist title="종류 (여럿 고르면 각각)" t={t} rows={GROUPS} />
            </div>
          </div>
        </div>
      </section>

      <div className="grid-3">
        <PlaceList title="많이 뽑힌 가게" items={data.places.picked} empty="아직 없어요" />
        <PlaceList title="많이 공유된 가게" items={data.places.shared} empty="아직 없어요" />
        <PlaceList title={'"여긴 빼줘"가 많은 가게'} items={data.places.excluded} empty="아직 없어요" />
      </div>

      <section className="card">
        <h2 className="sec-title">퍼지는 정도</h2>
        <div className="rates rates-4">
          <Rate
            label="공유 → 링크 열림"
            value={ratio(v(t, "share_open"), v(t, "share"))}
            prev={p ? ratio(v(p, "share_open"), v(p, "share")) : undefined}
            hint={`공유 ${num(v(t, "share"))} · 열림 ${num(v(t, "share_open"))}`}
          />
          <Rate
            label="받은 사람의 다시 공유"
            value={ratio(v(t, "reshare_sessions"), v(t, "link_sessions"))}
            prev={p ? ratio(v(p, "reshare_sessions"), v(p, "link_sessions")) : undefined}
            hint={`링크로 연 세션 ${num(v(t, "link_sessions"))}`}
          />
          <Rate
            label="확정 공유 비율"
            value={ratio(v(t, "share_confirm"), v(t, "share"))}
            hint={`여기로 가요 ${num(v(t, "share_confirm"))}`}
          />
        </div>
      </section>
    </div>
  );
}
