import { deltaOf, type Alert, type Kpi, type OverviewData } from "../../shared/dashboard";
import { HUBS, hubById } from "../../shared/hubs";
import { Mascot } from "../components/Mascot";
import { Heatmap, Sparkline, StackedColumns } from "./charts";
import { delta, num, pct, shortDay, weekdayLabel } from "./format";

export const hubName = (id: string) => (HUBS.some((h) => h.id === id) ? hubById(id).name : id);

const LEVEL_LABEL: Record<Alert["level"], string> = { crit: "긴급", warn: "주의", info: "참고" };

/** R52 "오늘의 이상 신호" 띠 */
export function AlertStrip({ alerts }: { alerts: Alert[] }) {
  return (
    <section className="alerts" aria-label="오늘의 이상 신호">
      <h2 className="sec-title">오늘의 이상 신호</h2>
      {alerts.length === 0 ? (
        <p className="alert-ok">
          <span className="a-dot ok" aria-hidden="true" />
          이상 신호가 없어요
        </p>
      ) : (
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.code} className={`alert lv-${a.level}`}>
              <span className="alert-badge">{LEVEL_LABEL[a.level]}</span>
              {a.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function KpiCard({ label, kpi, format, sub, compare }: {
  label: string; kpi: Kpi; format: (v: number | null) => string; sub?: string; compare: boolean;
}) {
  const d = compare ? deltaOf(kpi.value, kpi.prev) : null;
  const dir = d === null ? "" : d > 0.005 ? "up" : d < -0.005 ? "down" : "flat";
  return (
    <div className="card kpi">
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{format(kpi.value)}</p>
      <div className="kpi-foot">
        {compare && (
          <span className={`delta ${dir}`} title="이전 기간 대비">
            {d === null ? "비교 없음" : (
              <>
                <span aria-hidden="true">{dir === "up" ? "▲" : dir === "down" ? "▼" : "■"}</span> {delta(d)}
              </>
            )}
          </span>
        )}
        {sub && <span className="muted small">{sub}</span>}
      </div>
      <Sparkline values={kpi.spark} label={`${label} 최근 14일 추이`} />
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="a-state-card">
      <Mascot pose="waiting" height={96} />
      <p className="a-state-title">{title}</p>
      <p className="muted small">{body}</p>
    </div>
  );
}

/** 기간 안에 집계 중(missing)인 날이 있으면 알린다 */
export function SourceNote({ sources }: { sources: Record<string, string> }) {
  const missing = Object.entries(sources).filter(([, s]) => s === "missing").map(([d]) => d);
  const live = Object.entries(sources).filter(([, s]) => s === "live").map(([d]) => d);
  if (missing.length === 0 && live.length === 0) return null;
  return (
    <p className="source-note muted small">
      {live.length > 0 && <>실시간: {live.map(shortDay).join(", ")} (최대 5분 전 기준). </>}
      {missing.length > 0 && <>아직 집계 전인 날 {missing.length}일은 빼고 계산했어요.</>}
    </p>
  );
}

export function Overview({ data }: { data: OverviewData }) {
  const k = data.kpis;
  const compare = data.range.compare;
  const multi = data.range.days > 1;
  const empty = (k.sessions.value ?? 0) === 0;
  return (
    <div className="stack-lg">
      <AlertStrip alerts={data.alerts} />
      <section aria-label="핵심 지표">
        <div className="kpi-grid">
          <KpiCard
            label={multi ? "사용자 (일평균)" : "사용자"}
            kpi={k.users}
            format={num}
            sub={k.newUsers.value !== null ? `신규 ${num(k.newUsers.value)}` : undefined}
            compare={compare}
          />
          <KpiCard label="세션" kpi={k.sessions} format={num} compare={compare} />
          <KpiCard label="결정률" kpi={k.decisionRate} format={(v) => pct(v)} sub="공유·카카오맵·여기로 가요" compare={compare} />
          <KpiCard label="뽑기 / 세션" kpi={k.drawsPerSession} format={(v) => (v === null ? "–" : v.toFixed(2))} sub="직접 뽑기만" compare={compare} />
          <KpiCard label="공유 링크 열림" kpi={k.shareOpens} format={num} compare={compare} />
        </div>
        <SourceNote sources={data.sources} />
      </section>

      {empty ? (
        <EmptyState title="이 기간에는 아직 기록이 없어요" body="앱을 연 사람이 생기면 여기에 바로 보여요." />
      ) : (
        <>
          <div className="grid-2">
            <section className="card">
              <div className="a-card-head">
                <h2 className="sec-title">일별 뽑기</h2>
                <span className="muted small">직접 = 뽑기·다시 뽑기, 자동 = 열자마자 뽑기(R39)</span>
              </div>
              <StackedColumns
                title="일별 뽑기"
                series={[
                  { key: "manual", name: "직접", className: "s-manual" },
                  { key: "auto", name: "자동", className: "s-auto" },
                ]}
                items={data.daily.map((d) => ({
                  label: shortDay(d.day),
                  values: [d.manual, d.auto],
                  missing: d.source === "missing",
                  note: "아직 집계 전이에요",
                }))}
              />
            </section>
            <section className="card">
              <div className="a-card-head">
                <h2 className="sec-title">요일 × 시간</h2>
                <span className="muted small">앱을 연 세션, KST</span>
              </div>
              <Heatmap grid={data.heatmap} rows={[0, 1, 2, 3, 4, 5, 6].map(weekdayLabel)} title="요일·시간대별 세션" unit="세션" />
            </section>
          </div>

          <section className="card">
            <div className="a-card-head">
              <h2 className="sec-title">거점별</h2>
              {multi && <span className="muted small">사용자는 일평균</span>}
            </div>
            <table className="rtable">
              <thead>
                <tr>
                  <th>거점</th>
                  <th className="num">사용자</th>
                  <th className="num">세션</th>
                  <th className="num">결정률</th>
                  <th className="num">직접 뽑기</th>
                  <th className="num">공유</th>
                </tr>
              </thead>
              <tbody>
                {[...data.hubs]
                  .sort((a, b) => b.sessions - a.sessions)
                  .map((h) => (
                    <tr key={h.hub}>
                      <td className="name">{hubName(h.hub)}</td>
                      <td className="num" data-label="사용자">{num(h.users)}</td>
                      <td className="num" data-label="세션">{num(h.sessions)}</td>
                      <td className="num" data-label="결정률">{pct(h.sessions > 0 ? h.decided / h.sessions : null)}</td>
                      <td className="num" data-label="직접 뽑기">{num(h.draws)}</td>
                      <td className="num" data-label="공유">{num(h.shares)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
