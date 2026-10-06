import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { DASHBOARD_MAX_DAYS, addDays, daysBetween, type DashboardResponse, type DashboardTab } from "../../shared/dashboard";
import { HUBS } from "../../shared/hubs";
import { kstDay } from "../../shared/kst";
import { Mascot } from "../components/Mascot";
import { Behavior } from "./Behavior";
import { ago } from "./format";
import { Ops } from "./Ops";
import { Overview } from "./Overview";
import "./admin.css";

/**
 * R52 관리자 대시보드 v2 (/admin). 메인 화면에서 링크하지 않는다 — 따로 불러오는 청크.
 * 토큰은 이 탭의 sessionStorage에만 두고 주소에는 넣지 않는다. 탭: 개요 · 사용자 행태 · 운영.
 * 공통 조작: 기간(오늘/7일/30일/직접 ≤ 90일, KST), 거점, 이전 기간 비교, 자동 새로고침(60초, 화면이 보일 때만, 30분 뒤 꺼짐).
 */
const TOKEN_KEY = "mmj:admin-token:v1";
const TABS: { id: DashboardTab; label: string }[] = [
  { id: "overview", label: "개요" },
  { id: "behavior", label: "사용자 행태" },
  { id: "ops", label: "운영" },
];
const PRESETS = [
  { id: "1", label: "오늘", days: 1 },
  { id: "7", label: "7일", days: 7 },
  { id: "30", label: "30일", days: 30 },
  { id: "custom", label: "직접", days: 0 },
] as const;
type PresetId = (typeof PRESETS)[number]["id"];
export const AUTO_REFRESH_MS = 60_000;
/** 자동 새로고침은 30분 뒤 스스로 꺼진다 (켜 둔 채 잊어도 D1 읽기가 쌓이지 않게) */
export const AUTO_REFRESH_MAX_MS = 30 * 60_000;

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
const tabFromHash = (): DashboardTab => {
  const h = window.location.hash.slice(1);
  return h === "behavior" || h === "ops" ? h : "overview";
};

type Load = { state: "idle" | "loading" } | { state: "error"; msg: string } | { state: "ok"; data: DashboardResponse; at: number };

export type Api = {
  token: string;
  /** 관리자 API 호출 (401이면 토큰을 지운다) */
  call: (path: string, init?: RequestInit) => Promise<Response>;
  /** 지금 탭을 캐시를 건너뛰고 다시 불러온다 (조작 직후) */
  reloadFresh: () => void;
};

export default function AdminPage() {
  const [token, setToken] = useState(readToken);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<DashboardTab>(tabFromHash);
  const today = kstDay(Date.now());
  const [preset, setPreset] = useState<PresetId>("7");
  const [custom, setCustom] = useState({ from: addDays(today, -13), to: today });
  const [hub, setHub] = useState("all");
  const [compare, setCompare] = useState(true);
  const [auto, setAuto] = useState(false);
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [nonce, setNonce] = useState({ n: 0, fresh: false });
  const [clock, setClock] = useState(Date.now());
  const autoSince = useRef(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    document.title = "모먹죠 대시보드";
  }, []);

  const logout = useCallback((msg?: string) => {
    saveToken("");
    setToken("");
    setLoad(msg ? { state: "error", msg } : { state: "idle" });
  }, []);

  const range = useMemo(() => {
    if (preset === "custom") {
      let { from, to } = custom;
      if (to > today) to = today;
      if (from > to) from = to;
      if (daysBetween(from, to) + 1 > DASHBOARD_MAX_DAYS) from = addDays(to, -(DASHBOARD_MAX_DAYS - 1));
      return { from, to };
    }
    const days = PRESETS.find((p) => p.id === preset)!.days;
    return { from: addDays(today, -(days - 1)), to: today };
  }, [preset, custom, today]);

  const call = useCallback(
    async (path: string, init?: RequestInit) => {
      const res = await fetch(path, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } });
      if (res.status === 401) logout("토큰이 맞지 않아요");
      return res;
    },
    [token, logout],
  );

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    setLoad((l) => (l.state === "ok" && l.data.tab === tab ? l : { state: "loading" }));
    const q = new URLSearchParams({ tab, from: range.from, to: range.to, hub, compare: compare ? "1" : "0" });
    if (nonce.fresh) q.set("fresh", "1");
    fetch(`/api/admin/dashboard?${q}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
      .then(async (res) => {
        if (ctrl.signal.aborted) return;
        if (res.status === 401) return logout("토큰이 맞지 않아요");
        // 429는 이 IP의 관리자 요청이 분당 120회를 넘었을 때 온다 (토큰 비교 전에 센다) — 토큰은 지우지 않는다
        if (res.status === 429) return setLoad({ state: "error", msg: "요청이 너무 많아요. 1분 뒤에 다시 해 주세요" });
        if (!res.ok) throw new Error(String(res.status));
        const data: DashboardResponse = await res.json();
        if (!ctrl.signal.aborted) setLoad({ state: "ok", data, at: Date.now() });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setLoad({ state: "error", msg: "대시보드를 불러오지 못했어요" });
      });
    return () => ctrl.abort();
  }, [token, tab, range.from, range.to, hub, compare, nonce, logout]);

  // 자동 새로고침: 60초마다, 화면이 보일 때만. 30분 지나면 끈다
  useEffect(() => {
    if (!auto || !token) return;
    autoSince.current = Date.now();
    const t = window.setInterval(() => {
      if (Date.now() - autoSince.current > AUTO_REFRESH_MAX_MS) {
        setAuto(false);
        return;
      }
      if (document.visibilityState === "visible") setNonce((x) => ({ n: x.n + 1, fresh: false }));
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [auto, token]);

  // "n분 전 업데이트" 표시용 시계
  useEffect(() => {
    const t = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(t);
  }, []);

  const selectTab = (id: DashboardTab, focus = false) => {
    setTab(id);
    window.history.replaceState(null, "", id === "overview" ? "/admin" : `/admin#${id}`);
    if (focus) tabRefs.current[TABS.findIndex((t) => t.id === id)]?.focus();
  };
  const onTabKey = (e: KeyboardEvent, i: number) => {
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    selectTab(TABS[(next + TABS.length) % TABS.length].id, true);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    if (!v) return;
    saveToken(v);
    setLoad({ state: "idle" });
    setToken(v);
    setDraft("");
  };

  const api: Api = useMemo(
    () => ({ token, call, reloadFresh: () => setNonce((x) => ({ n: x.n + 1, fresh: true })) }),
    [token, call],
  );

  if (!token) {
    return (
      <div className="adm">
        <main className="adm-login-wrap">
          <form className="adm-login" onSubmit={submit}>
            <img src="/brand/logo.webp" alt="모먹죠" width={72} height={32} draggable={false} />
            <h1>관리자 대시보드</h1>
            <label htmlFor="admin-token">관리자 토큰</label>
            <input
              id="admin-token"
              type="password"
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="ADMIN_TOKEN"
            />
            <button type="submit" className="btn btn-primary" disabled={!draft.trim()}>
              확인
            </button>
            {load.state === "error" && (
              <p className="adm-error" role="alert">
                {load.msg}
              </p>
            )}
            <p className="muted small">토큰은 이 탭에만 기억하고 주소에 남기지 않아요.</p>
          </form>
        </main>
      </div>
    );
  }

  const data = load.state === "ok" && load.data.tab === tab ? load.data : null;
  return (
    <div className="adm">
      <header className="adm-top">
        <div className="adm-top-row">
          <img src="/brand/logo.webp" alt="모먹죠" width={63} height={28} draggable={false} />
          <span className="adm-title">대시보드</span>
          <div className="tabs" role="tablist" aria-label="화면">
            {TABS.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                id={`tab-${t.id}`}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                aria-controls="adm-panel"
                tabIndex={tab === t.id ? 0 : -1}
                onClick={() => selectTab(t.id)}
                onKeyDown={(e) => onTabKey(e, i)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost adm-logout" onClick={() => logout()}>
            토큰 지우기
          </button>
        </div>
      </header>

      <div className="adm-controls" role="group" aria-label="보기 조건">
        <div className="seg2" role="group" aria-label="기간">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="dates">
            <input
              type="date"
              aria-label="시작일"
              value={custom.from}
              max={custom.to}
              min={addDays(today, -365)}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))}
            />
            <span aria-hidden="true">~</span>
            <input
              type="date"
              aria-label="종료일"
              value={custom.to}
              max={today}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))}
            />
          </div>
        )}
        <select className="select" aria-label="거점" value={hub} onChange={(e) => setHub(e.target.value)}>
          <option value="all">모든 거점</option>
          {HUBS.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <label className="a-switch">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} />
          <span className="a-switch-ui" aria-hidden="true" />
          이전 기간 비교
        </label>
        <label className="a-switch">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span className="a-switch-ui" aria-hidden="true" />
          자동 새로고침
        </label>
        <div className="adm-status">
          <span className="muted small" aria-live="polite">
            {range.from === range.to ? range.to : `${range.from} ~ ${range.to}`} (KST)
            {load.state === "ok" ? ` · ${ago(load.at, clock)} 업데이트` : ""}
          </span>
          <button
            type="button"
            className="btn btn-soft"
            onClick={() => setNonce((x) => ({ n: x.n + 1, fresh: false }))}
            disabled={load.state === "loading"}
          >
            새로고침
          </button>
        </div>
      </div>

      <main id="adm-panel" className="adm-main" role="tabpanel" aria-labelledby={`tab-${tab}`} aria-busy={load.state === "loading"}>
        {load.state === "error" && (
          <div className="a-state-card" role="alert">
            <Mascot pose="sad" height={88} />
            <p>{load.msg}</p>
            <button type="button" className="btn btn-soft" onClick={() => setNonce((x) => ({ n: x.n + 1, fresh: false }))}>
              다시 시도
            </button>
          </div>
        )}
        {!data && load.state !== "error" && <Skeleton tab={tab} />}
        {data?.tab === "overview" && <Overview data={data} />}
        {data?.tab === "behavior" && <Behavior data={data} />}
        {data?.tab === "ops" && <Ops data={data} api={api} />}
      </main>
    </div>
  );
}

/** 불러오는 동안 같은 모양의 회색 틀 */
function Skeleton({ tab }: { tab: DashboardTab }) {
  return (
    <div className="skel" aria-label="불러오는 중이에요">
      <div className="kpi-grid">
        {Array.from({ length: tab === "ops" ? 3 : 5 }, (_, i) => (
          <div key={i} className="card skel-card">
            <span className="skel-line w40" />
            <span className="skel-line w60 tall" />
            <span className="skel-line w80" />
          </div>
        ))}
      </div>
      <div className="grid-2">
        <div className="card skel-block" />
        <div className="card skel-block" />
      </div>
    </div>
  );
}
