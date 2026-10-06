import { useEffect, useRef, useState } from "react";
import {
  BUDGET_BLOCK_AT, D1_DAILY_READ_LIMIT, D1_DAILY_WRITE_LIMIT, budgetFraction, budgetLevel, type HubStatus, type OpsData,
} from "../../shared/dashboard";
import { HUBS } from "../../shared/hubs";
import type { Api } from "./AdminPage";
import { Meter } from "./charts";
import { ago, kstTime, num, pct, until } from "./format";
import { AlertStrip, hubName } from "./Overview";

/** 대시보드 링크 (계정은 Cloudflare가 고르게 한다 — API 토큰 없음) */
const CF_LINKS = [
  { label: "Workers 지표", href: "https://dash.cloudflare.com/?to=/:account/workers/services/view/momeokjo/production/metrics" },
  { label: "D1 지표", href: "https://dash.cloudflare.com/?to=/:account/workers/d1/databases/18eb38e3-a7a4-472f-ac40-0080fb7ff87e/metrics" },
];
/** 조작 반복 상한 (warm.mjs·backfill.mjs와 같은 정신 — 화면에서는 짧게) */
const WARM_MAX_CALLS = 30;
const BACKFILL_MAX_CALLS = 20;
const WARM_GAP_MS = 1000;

type Kind = "warm" | "backfill";
type Run = {
  hub: string;
  kind: Kind;
  state: "running" | "done" | "stopped" | "error";
  calls: number;
  read: number;
  written: number;
  remaining: string;
  msg?: string;
};
const KIND_LABEL: Record<Kind, string> = { warm: "수집(warm)", backfill: "상세 채우기(backfill)" };

const days = (ms: number | null, now: number) => (ms === null ? "–" : `${Math.max(0, Math.floor((now - ms) / 86_400_000))}일`);

function Confirm({ open, title, body, onYes, onNo }: { open: boolean; title: string; body: string; onYes: () => void; onNo: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal?.();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onCancel={onNo} aria-labelledby="dlg-title">
      <h2 id="dlg-title" className="sec-title">
        {title}
      </h2>
      <p className="dialog-body">{body}</p>
      <div className="dialog-actions">
        <button type="button" className="btn btn-ghost" onClick={onNo}>
          취소
        </button>
        <button type="button" className="btn btn-primary" onClick={onYes} autoFocus>
          실행
        </button>
      </div>
    </dialog>
  );
}

function HubTable({ hubs, now, blocked, onRun, running }: {
  hubs: HubStatus[]; now: number; blocked: boolean; onRun: (hub: string, kind: Kind) => void; running: boolean;
}) {
  return (
    <table className="rtable hubs">
      <thead>
        <tr>
          <th>거점</th>
          <th className="num">가게</th>
          <th className="num">상세 채움</th>
          <th className="num">미수집</th>
          <th className="num">미완료 격자</th>
          <th className="num">목록 조각</th>
          <th className="num">가장 오래된 상세</th>
          <th className="num">마지막 격자 수집</th>
          <th>조작</th>
        </tr>
      </thead>
      <tbody>
        {hubs.map((h) => {
          const filled = h.places > 0 ? h.ok / h.places : null;
          return (
            <tr key={h.hub}>
              <td className="name">{hubName(h.hub)}</td>
              <td className="num" data-label="가게">{num(h.places)}</td>
              <td className="num" data-label="상세 채움">
                <span className={filled !== null && filled < 0.95 ? "warn-text" : ""}>{pct(filled)}</span>
                {h.failed > 0 && <small className="muted"> 실패 {num(h.failed)}</small>}
              </td>
              <td className="num" data-label="미수집">
                <span className={h.pending > 0 ? "warn-text" : ""}>{num(h.pending)}</span>
              </td>
              <td className="num" data-label="미완료 격자">
                <span className={h.incompleteTiles > 0 ? "warn-text" : ""}>
                  {num(h.incompleteTiles)}
                  <small className="muted"> / {num(h.tiles)}</small>
                </span>
              </td>
              <td className="num" data-label="목록 조각">{pct(h.visible > 0 ? h.listReady / h.visible : null)}</td>
              <td className="num" data-label="가장 오래된 상세">{days(h.oldestOkAt, now)}</td>
              <td className="num" data-label="마지막 격자 수집">{ago(h.lastTileAt, now)}</td>
              <td className="act-cell">
                <div className="action-row">
                  <button type="button" className="btn btn-sm" disabled={blocked || running} onClick={() => onRun(h.hub, "warm")}>
                    수집
                  </button>
                  <button type="button" className="btn btn-sm" disabled={blocked || running} onClick={() => onRun(h.hub, "backfill")}>
                    상세 채우기
                  </button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Ops({ data, api }: { data: OpsData; api: Api }) {
  const [now, setNow] = useState(Date.now());
  const [ask, setAsk] = useState<{ hub: string; kind: Kind } | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const stop = useRef(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const b = data.ops.budget;
  const frac = budgetFraction(b);
  const blocked = frac >= BUDGET_BLOCK_AT;
  const k = data.ops.kakao;
  const frozen = k.frozen && now < k.frozen.until ? k.frozen : null;
  const cron = data.ops.cron;
  const running = run?.state === "running";

  const start = async (hub: string, kind: Kind) => {
    setAsk(null);
    stop.current = false;
    const h = HUBS.find((x) => x.id === hub)!;
    let r: Run = { hub, kind, state: "running", calls: 0, read: 0, written: 0, remaining: "확인 중" };
    setRun(r);
    const max = kind === "warm" ? WARM_MAX_CALLS : BACKFILL_MAX_CALLS;
    const path =
      kind === "warm"
        ? `/api/admin/warm?lat=${h.lat}&lng=${h.lng}&radius=1000`
        : `/api/admin/backfill?hub=${encodeURIComponent(hub)}`;
    try {
      for (let i = 0; i < max; i++) {
        if (stop.current) {
          r = { ...r, state: "stopped", msg: "멈췄어요" };
          break;
        }
        const res = await api.call(path, { method: "POST" });
        if (res.status === 429) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          const msg =
            e.error === "rate_limited"
              ? "관리자 요청 제한(분당 120회)에 걸려 멈췄어요. 1분 뒤 다시 해 주세요"
              : "오늘 D1 예산 소프트 한도라 멈췄어요";
          r = { ...r, state: "stopped", msg };
          break;
        }
        if (!res.ok) {
          r = { ...r, state: "error", msg: `요청이 실패했어요 (${res.status})` };
          break;
        }
        const j = (await res.json()) as Record<string, unknown>;
        const read = Number(j.rowsRead ?? 0);
        const written = Number(j.rowsWritten ?? 0);
        const done =
          kind === "warm" ? j.incompleteTiles === 0 && j.pending === 0 : j.remaining === 0;
        const remaining =
          kind === "warm"
            ? `미완료 격자 ${num(Number(j.incompleteTiles ?? 0))} · 미수집 ${j.pending === "more" ? "남음" : num(Number(j.pending ?? 0))}`
            : j.remaining === 0
              ? "남은 조각 없음"
              : `이번에 ${num(Number(j.filled ?? 0))}곳 채움 · 더 있음`;
        r = { ...r, calls: r.calls + 1, read: r.read + read, written: r.written + written, remaining };
        setRun(r);
        if (done) {
          r = { ...r, state: "done", msg: kind === "warm" ? "남은 격자·상세가 없어요" : "남은 조각이 없어요" };
          break;
        }
        if (i === max - 1) r = { ...r, state: "stopped", msg: `한 번에 ${max}회까지만 해요. 더 필요하면 다시 눌러 주세요` };
        else if (kind === "warm") await new Promise((ok) => setTimeout(ok, WARM_GAP_MS));
      }
    } catch {
      r = { ...r, state: "error", msg: "네트워크 오류로 멈췄어요" };
    }
    setRun(r);
    api.reloadFresh();
  };

  return (
    <div className="stack-lg">
      <AlertStrip alerts={data.alerts} />

      <section className="card">
        <div className="a-card-head">
          <h2 className="sec-title">무료 한도 (오늘, UTC 기준)</h2>
          <span className="muted small">
            {kstTime(b.resetAt)} KST 초기화까지 {until(b.resetAt, now)}
          </span>
        </div>
        <div className="grid-3">
          <div className="gauge">
            <p className="gauge-label">D1 읽기</p>
            <p className="gauge-value">
              {num(b.read)} <small className="muted">/ {num(D1_DAILY_READ_LIMIT)}행</small>
            </p>
            <Meter value={b.read} limit={D1_DAILY_READ_LIMIT} soft={b.readSoftCap} level={budgetLevel(b.read / b.readSoftCap)} label="D1 읽기" />
            <p className="muted small">
              소프트 한도 {num(b.readSoftCap)}의 <b className={`lv-text-${budgetLevel(b.read / b.readSoftCap)}`}>{pct(b.read / b.readSoftCap)}</b> — 넘으면 수집을 멈춰요
            </p>
          </div>
          <div className="gauge">
            <p className="gauge-label">D1 쓰기</p>
            <p className="gauge-value">
              {num(b.written)} <small className="muted">/ {num(D1_DAILY_WRITE_LIMIT)}행</small>
            </p>
            <Meter value={b.written} limit={D1_DAILY_WRITE_LIMIT} soft={b.writeSoftCap} level={budgetLevel(b.written / b.writeSoftCap)} label="D1 쓰기" />
            <p className="muted small">
              소프트 한도 {num(b.writeSoftCap)}의 <b className={`lv-text-${budgetLevel(b.written / b.writeSoftCap)}`}>{pct(b.written / b.writeSoftCap)}</b> — 넘으면 이벤트를 받지 않아요
            </p>
          </div>
          <div className="gauge">
            <p className="gauge-label">오늘(KST) 받은 이벤트</p>
            <p className="gauge-value">{data.eventsToday === null ? "–" : num(data.eventsToday)}</p>
            <p className="muted small">
              {data.eventsToday === null
                ? "예산 보호로 세지 않았어요"
                : `쓰기 약 ${num(data.eventsToday * 4)}행 (이벤트당 4행 추정)`}
            </p>
            <div className="links">
              {CF_LINKS.map((l) => (
                <a key={l.href} className="btn btn-sm btn-ghost" href={l.href} target="_blank" rel="noreferrer">
                  {l.label} ↗
                </a>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="sec-title">카카오 · 수집 상태</h2>
        <dl className="status-grid">
          <div>
            <dt>상세 가져오기</dt>
            <dd>
              {frozen ? (
                <span className="pill lv-crit">하루 멈춤 · {kstTime(frozen.since)}부터</span>
              ) : now < k.blockedUntil ? (
                <span className="pill lv-warn">쿨다운 · {kstTime(k.blockedUntil, false)}까지</span>
              ) : (
                <span className="pill lv-ok">정상</span>
              )}
            </dd>
          </div>
          <div>
            <dt>오늘 차단(403·429)</dt>
            <dd>{num(k.blocksToday)}번 <small className="muted">3번이면 하루 멈춤</small></dd>
          </div>
          <div>
            <dt>마지막 Cron</dt>
            <dd>
              {cron ? (
                <>
                  {ago(cron.at, now)} <small className="muted">({kstTime(cron.at)})</small>
                </>
              ) : (
                "기록 없음"
              )}
            </dd>
          </div>
          <div>
            <dt>그 실행 결과</dt>
            <dd>
              {cron ? (
                cron.skipped ? (
                  <span className="pill lv-warn">건너뜀 · {cron.skipped === "read_budget" ? "읽기 예산" : cron.skipped}</span>
                ) : (
                  <>
                    격자 {num(cron.collected)} · 상세 {num(cron.enriched)}
                    {cron.failed > 0 ? ` (실패 ${num(cron.failed)})` : ""} · 외부 호출 {num(cron.calls)}
                    {cron.rolled > 0 ? ` · 집계 ${cron.rolled}일` : ""}
                  </>
                )
              ) : (
                "–"
              )}
            </dd>
          </div>
          <div>
            <dt>일별 집계</dt>
            <dd>{data.rollupThrough ? `${data.rollupThrough}까지` : "아직 없음"}</dd>
          </div>
          <div>
            <dt>로컬 API 오늘 호출</dt>
            <dd className="muted">따로 세지 않아요 (마지막 Cron의 외부 호출만)</dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <div className="a-card-head">
          <h2 className="sec-title">거점별 데이터 상태</h2>
          <span className="muted small">{ago(data.hubsComputedAt, now)} 계산 (15분마다)</span>
        </div>
        {blocked && (
          <p className="banner lv-crit" role="status">
            오늘 예산을 {pct(frac)} 써서 조작 버튼을 잠갔어요 (90% 이상).
          </p>
        )}
        <HubTable hubs={data.hubs} now={now} blocked={blocked} running={running} onRun={(hub, kind) => setAsk({ hub, kind })} />
        {run && (
          <div className={`run-panel lv-${run.state === "running" ? "info" : run.state === "done" ? "ok" : "warn"}`} role="status" aria-live="polite">
            <div className="run-head">
              <b>
                {hubName(run.hub)} · {KIND_LABEL[run.kind]}
              </b>
              {running ? (
                <button type="button" className="btn btn-sm" onClick={() => (stop.current = true)}>
                  멈추기
                </button>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRun(null)}>
                  닫기
                </button>
              )}
            </div>
            <p>
              호출 {num(run.calls)}번 · 읽기 {num(run.read)}행 · 쓰기 {num(run.written)}행 · {run.remaining}
            </p>
            {run.msg && <p className="muted small">{run.msg}</p>}
          </div>
        )}
      </section>

      <Confirm
        open={ask !== null}
        title={ask ? `${hubName(ask.hub)} ${KIND_LABEL[ask.kind]}` : ""}
        body={
          ask?.kind === "warm"
            ? "카카오 로컬·상세 API를 부르고 D1을 읽어요 (호출마다 수천 행). 끝나거나 30번까지 1초 간격으로 반복해요."
            : "목록 조각(list_json)이 없는 가게를 300곳씩 채워요. 외부 호출은 없고, 끝나거나 20번까지 반복해요."
        }
        onYes={() => ask && void start(ask.hub, ask.kind)}
        onNo={() => setAsk(null)}
      />
    </div>
  );
}
