import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import type { StatsResponse } from "../../shared/events";
import { HUBS, hubById } from "../../shared/hubs";
import "./admin.css";

/**
 * R36 관리자 통계 (/admin). 메인 화면에서 링크하지 않는다.
 * 토큰은 이 탭의 sessionStorage에만 두고 주소에는 넣지 않는다.
 */
const TOKEN_KEY = "mmj:admin-token:v1";
const RANGES = [
  { days: 1, label: "오늘" },
  { days: 7, label: "7일" },
  { days: 30, label: "30일" },
] as const;

const n = (v: number) => v.toLocaleString("ko-KR");
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const hubName = (id: string) => (HUBS.some((h) => h.id === id) ? hubById(id).name : id);
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveToken(v: string) {
  try {
    if (v) sessionStorage.setItem(TOKEN_KEY, v);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 이번 화면에서만 쓴다 */
  }
}

type Load = { state: "idle" | "loading" } | { state: "error"; msg: string } | { state: "ok"; data: StatsResponse };

/** 한 계열 막대 (범례 없음 — 제목이 이름). 막대를 누르거나 가리키면 아래 줄에 값이 나온다 */
function Bars(props: {
  title: string;
  values: number[];
  labels: string[];
  /** 축에 보여줄 라벨 위치 */
  ticks: number[];
  describe: (i: number) => string;
}) {
  const { title, values, labels, ticks, describe } = props;
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...values);
  const peak = values.indexOf(Math.max(...values));
  const shown = active ?? (values[peak] > 0 ? peak : null);
  return (
    <figure className="bars-fig">
      <div className="bars" style={{ "--n": values.length } as CSSProperties} onMouseLeave={() => setActive(null)}>
        {values.map((v, i) => (
          <button
            key={labels[i]}
            type="button"
            className={`bar${i === shown ? " is-active" : ""}`}
            aria-label={describe(i)}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onClick={() => setActive(i)}
          >
            <span className="bar-fill" style={{ height: v > 0 ? `max(3px, ${(v / max) * 100}%)` : 0 }} />
          </button>
        ))}
      </div>
      <div className="bars-axis" style={{ "--n": values.length } as CSSProperties} aria-hidden="true">
        {ticks.map((i) => (
          <span key={i} style={{ gridColumn: i + 1 }}>
            {labels[i]}
          </span>
        ))}
      </div>
      <figcaption className="bars-caption" aria-live="polite">
        {shown !== null ? describe(shown) : `${title} 기록이 없어요`}
      </figcaption>
    </figure>
  );
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {sub && <p className="stat-sub">{sub}</p>}
    </div>
  );
}

function Stats({ data }: { data: StatsResponse }) {
  const t = data.totals;
  const draws = t.draws + t.redraws;
  const hourTicks = [0, 6, 12, 18, 23];
  const dayTicks = data.daily.length <= 7
    ? data.daily.map((_, i) => i)
    : [0, Math.floor((data.daily.length - 1) / 2), data.daily.length - 1];
  const d1 = data.d1Today;
  const readShare = Math.min(1, d1.read / d1.readSoftCap);
  return (
    <>
      <section className="stat-grid" aria-label="요약">
        <Card label="사용자" value={n(t.users)} sub={`세션 ${n(t.sessions)}`} />
        <Card label="세션" value={n(t.sessions)} sub={`세션당 뽑기 ${data.drawsPerSession === null ? "–" : data.drawsPerSession.toFixed(1)}`} />
        <Card label="뽑기" value={n(draws)} sub={`다시 뽑기 ${n(t.redraws)} · 자동 ${n(t.autoDraws)}`} />
        <Card label="공유율" value={pct(data.conversion.toShare)} sub={`카카오맵 ${pct(data.conversion.toKakao)}`} />
      </section>
      <p className="admin-note">
        공유율·카카오맵은 직접 뽑기한 세션 {n(data.conversion.drawSessions)}개 중 그 행동까지 간 비율이에요(자동 뽑기는 뽑기 수·비율에서 빼요). 공유 {n(t.shares)}번(확정 {n(t.confirmShares)}) · 받은
        링크 열림 {n(t.shareOpens)}번.
      </p>

      <section className="admin-sec">
        <h2>시간대별 뽑기</h2>
        <Bars
          title="뽑기"
          values={data.hourly}
          labels={data.hourly.map((_, h) => `${h}시`)}
          ticks={hourTicks}
          describe={(h) => `${h}시 · 뽑기 ${n(data.hourly[h])}번`}
        />
      </section>

      {data.daily.length > 1 && (
        <section className="admin-sec">
          <h2>일별 뽑기</h2>
          <Bars
            title="뽑기"
            values={data.daily.map((d) => d.draws + d.redraws)}
            labels={data.daily.map((d) => shortDay(d.day))}
            ticks={dayTicks}
            describe={(i) => {
              const d = data.daily[i];
              return `${shortDay(d.day)} · 뽑기 ${n(d.draws + d.redraws)}번 · 사용자 ${n(d.users)} · 세션 ${n(d.sessions)}`;
            }}
          />
          <details className="admin-details">
            <summary>표로 보기</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>날짜</th><th>사용자</th><th>세션</th><th>뽑기</th><th>다시</th><th>공유</th><th>카카오맵</th><th>링크 열림</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.daily].reverse().map((d) => (
                    <tr key={d.day}>
                      <td>{shortDay(d.day)}</td><td>{n(d.users)}</td><td>{n(d.sessions)}</td><td>{n(d.draws)}</td>
                      <td>{n(d.redraws)}</td><td>{n(d.shares)}</td><td>{n(d.openKakao)}</td><td>{n(d.shareOpens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}

      <section className="admin-sec">
        <h2>많이 뽑힌 가게</h2>
        {data.top.length === 0 ? (
          <p className="admin-empty">아직 뽑힌 가게가 없어요</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th className="num">#</th><th>가게</th><th className="num">뽑힘</th></tr>
              </thead>
              <tbody>
                {data.top.map((p, i) => (
                  <tr key={p.placeId}>
                    <td className="num">{i + 1}</td>
                    <td className="name">
                      <a href={`https://place.map.kakao.com/${p.placeId}`} target="_blank" rel="noreferrer">
                        {p.name ?? p.placeId}
                      </a>
                    </td>
                    <td className="num">{n(p.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-sec">
        <h2>결과 카드 번호별</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>카드</th><th className="num">펼침</th><th className="num">카카오맵</th><th className="num">빼줘</th></tr>
            </thead>
            <tbody>
              {[0, 1, 2].map((i) => (
                <tr key={i}>
                  <td>{i + 1}번</td>
                  <td className="num">{n(data.ranks.expand[i])}</td>
                  <td className="num">{n(data.ranks.kakao[i])}</td>
                  <td className="num">{n(data.ranks.exclude[i])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-sec">
        <h2>거점별</h2>
        {data.hubs.length === 0 ? (
          <p className="admin-empty">기록이 없어요</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>거점</th><th className="num">사용자</th><th className="num">세션</th><th className="num">뽑기</th><th className="num">공유</th></tr>
              </thead>
              <tbody>
                {data.hubs.map((h) => (
                  <tr key={h.hub}>
                    <td className="name">{hubName(h.hub)}</td>
                    <td className="num">{n(h.users)}</td>
                    <td className="num">{n(h.sessions)}</td>
                    <td className="num">{n(h.draws)}</td>
                    <td className="num">{n(h.shares)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-sec">
        <h2>오늘(UTC 기준, 09시 초기화) D1 사용량 (추정)</h2>
        <div className="meter" role="img" aria-label={`읽기 ${n(d1.read)}행, 소프트 한도 ${n(d1.readSoftCap)}행의 ${pct(readShare)}`}>
          <span className={`meter-fill${readShare >= 0.8 ? " is-high" : ""}`} style={{ width: `${readShare * 100}%` }} />
        </div>
        <p className="admin-note">
          읽기 {n(d1.read)}행 / 한도 {n(d1.readSoftCap)}행 ({pct(readShare)}) · 쓰기 {n(d1.written)}행. 한도를 넘으면 그날은 수집을 멈춰요.
        </p>
      </section>
    </>
  );
}

export default function AdminPage() {
  const [token, setToken] = useState(readToken);
  const [draft, setDraft] = useState("");
  const [days, setDays] = useState<number>(7);
  const [hub, setHub] = useState("all");
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    document.title = "모먹죠 통계";
  }, []);

  const logout = useCallback((msg?: string) => {
    saveToken("");
    setToken("");
    setLoad(msg ? { state: "error", msg } : { state: "idle" });
  }, []);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    setLoad({ state: "loading" });
    const q = new URLSearchParams({ days: String(days), hub });
    fetch(`/api/admin/stats?${q}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
      .then(async (res) => {
        if (ctrl.signal.aborted) return;
        if (res.status === 401) return logout("토큰이 맞지 않아요");
        // 429는 이 IP의 관리자 요청이 분당 120회를 넘었을 때 온다 (토큰 비교 전에 센다) — 토큰은 지우지 않는다
        if (res.status === 429) return setLoad({ state: "error", msg: "요청이 너무 많아요. 1분 뒤에 다시 해 주세요" });
        if (!res.ok) throw new Error(String(res.status));
        const data: StatsResponse = await res.json();
        if (!ctrl.signal.aborted) setLoad({ state: "ok", data });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoad({ state: "error", msg: "통계를 불러오지 못했어요" });
      });
    return () => ctrl.abort();
  }, [token, days, hub, nonce, logout]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    if (!v) return;
    saveToken(v);
    setLoad({ state: "idle" });
    setToken(v);
    setDraft("");
  };

  const rangeIndex = RANGES.findIndex((r) => r.days === days);
  return (
    <div className="admin">
      <header className="admin-top">
        <img src="/brand/logo.webp" alt="모먹죠" width={63} height={28} draggable={false} />
        <h1>사용 통계</h1>
        {token && (
          <button type="button" className="admin-link" onClick={() => logout()}>
            토큰 지우기
          </button>
        )}
      </header>
      <main className="admin-main">
        {!token ? (
          <form className="admin-login" onSubmit={submit}>
            <label htmlFor="admin-token">관리자 토큰</label>
            <input
              id="admin-token"
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="ADMIN_TOKEN"
            />
            <button type="submit" className="admin-btn" disabled={!draft.trim()}>
              확인
            </button>
            {load.state === "error" && <p className="admin-error" role="alert">{load.msg}</p>}
            <p className="admin-note">토큰은 이 탭에만 기억하고 주소에 남기지 않아요.</p>
          </form>
        ) : (
          <>
            <div className="admin-controls">
              <div
                className="seg"
                role="group"
                aria-label="기간"
                style={{ "--n": RANGES.length, "--i": Math.max(rangeIndex, 0) } as CSSProperties}
              >
                <span className="seg-thumb" aria-hidden="true" />
                {RANGES.map((r) => (
                  <button key={r.days} type="button" aria-pressed={r.days === days} onClick={() => setDays(r.days)}>
                    {r.label}
                  </button>
                ))}
              </div>
              <select className="admin-select" aria-label="거점" value={hub} onChange={(e) => setHub(e.target.value)}>
                <option value="all">모든 거점</option>
                {HUBS.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
              <button type="button" className="admin-btn is-tint" onClick={() => setNonce((x) => x + 1)}>
                새로고침
              </button>
            </div>
            {load.state === "ok" && (
              <p className="admin-range">
                {load.data.range.from === load.data.range.to
                  ? load.data.range.to
                  : `${load.data.range.from} ~ ${load.data.range.to}`}{" "}
                (KST)
              </p>
            )}
            {load.state === "loading" && <p className="admin-note" aria-live="polite">불러오는 중이에요…</p>}
            {load.state === "error" && (
              <p className="admin-error" role="alert">
                {load.msg}
              </p>
            )}
            {load.state === "ok" && <Stats data={load.data} />}
          </>
        )}
      </main>
    </div>
  );
}
