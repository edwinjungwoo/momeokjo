import {
  ANON_KEY, MAX_EVENTS_PER_REQUEST, SESSION_KEY, nextSession, type EventProps, type EventType, type TrackedEvent,
} from "../shared/events";
import type { Filters } from "../shared/recommend";

/**
 * R35 익명 사용 통계. 화면을 절대 막지 않는다: 모든 함수는 예외를 던지지 않고, 전송 실패는 버린다.
 * 브라우저 id(localStorage)와 탭 세션 id(sessionStorage, 30분 무활동이면 새로)만 보낸다.
 * 개발 서버에서는 ?track=1일 때만 보낸다. /admin은 세지 않는다.
 */
const ENDPOINT = "/api/events";
const FLUSH_MS = 10_000;
const FLUSH_AT = 10;
/** 오프라인 등으로 쌓이기만 하면 오래된 것부터 버린다 */
const MAX_QUEUE = 100;
const FILTER_DEBOUNCE_MS = 1_000;

const enabled = (() => {
  try {
    if (window.location.pathname === "/admin") return false;
    return import.meta.env.PROD || new URLSearchParams(window.location.search).get("track") === "1";
  } catch {
    return false;
  }
})();

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // http(LAN 개발 서버)처럼 보안 컨텍스트가 아니면 randomUUID가 없다
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let memAnon: string | null = null;
function anonId(): string {
  try {
    let v = localStorage.getItem(ANON_KEY);
    if (!v || !/^[0-9a-f-]{36}$/.test(v)) {
      v = uuid();
      localStorage.setItem(ANON_KEY, v);
    }
    return v;
  } catch {
    // 저장할 수 없으면 이번 페이지 동안만 쓰는 id
    return (memAnon ??= uuid());
  }
}

let memSession: string | null = null;
function touchSession(now: number): { id: string; isNew: boolean } {
  let raw: string | null = memSession;
  try {
    raw = sessionStorage.getItem(SESSION_KEY) ?? memSession;
  } catch {
    /* 메모리 값을 쓴다 */
  }
  const s = nextSession(raw, now, uuid);
  memSession = s.stored;
  try {
    sessionStorage.setItem(SESSION_KEY, s.stored);
  } catch {
    /* 메모리에만 둔다 */
  }
  return s;
}

let hub = "";
let queue: TrackedEvent[] = [];
let queueSession: string | null = null;
let timer: number | null = null;

function send(session: string, events: TrackedEvent[]) {
  const body = JSON.stringify({ anon: anonId(), session, events });
  try {
    if (navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
  } catch {
    /* fetch로 넘어간다 */
  }
  try {
    void fetch(ENDPOINT, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(
      () => {},
    );
  } catch {
    /* 버린다 */
  }
}

function flush() {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
  const session = queueSession;
  if (!session || queue.length === 0) return;
  const all = queue;
  queue = [];
  for (let i = 0; i < all.length; i += MAX_EVENTS_PER_REQUEST) send(session, all.slice(i, i + MAX_EVENTS_PER_REQUEST));
}

function push(e: TrackedEvent) {
  queue.push(e);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  if (queue.length >= FLUSH_AT) flush();
  else if (timer === null) timer = window.setTimeout(flush, FLUSH_MS);
}

/** 세션을 이어 쓰거나 새로 시작한다. 새 세션이면 app_open을 먼저 넣는다 */
function ensureSession(now: number, props?: EventProps) {
  const s = touchSession(now);
  if (s.id !== queueSession) {
    flush();
    queueSession = s.id;
  }
  if (s.isNew) push({ t: "app_open", ts: now, hub, ...(props ? { props } : {}) });
}

if (enabled) {
  try {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
  } catch {
    /* 무시 */
  }
}

/** 지금 거점 (모든 이벤트에 붙는다) */
export function setTrackingHub(hubId: string) {
  hub = hubId;
}

/** 앱을 열 때 한 번. 세션이 새로 시작됐으면 app_open을 보낸다 (새로고침은 같은 세션) */
export function startTracking(hubId: string, props?: EventProps) {
  if (!enabled) return;
  try {
    hub = hubId;
    ensureSession(Date.now(), props);
  } catch {
    /* 무시 */
  }
}

export function track(t: Exclude<EventType, "app_open">, opts: { placeId?: string; props?: EventProps } = {}) {
  if (!enabled || !hub) return;
  try {
    const now = Date.now();
    ensureSession(now);
    push({
      t, ts: now, hub, ...(opts.placeId ? { placeId: opts.placeId } : {}), ...(opts.props ? { props: opts.props } : {}),
    });
  } catch {
    /* 무시 */
  }
}

/** 필터 스냅숏 (자유 입력 없음) */
export function filterProps(f: Filters): EventProps {
  return {
    radius: f.radius, party: f.party, groups: f.groups.slice(), priceCap: String(f.priceCap) as EventProps["priceCap"],
    minRating: f.minRating, openOnly: f.openOnly,
  };
}

let filterTimer: number | null = null;
/** filter_change는 1초 동안 더 바뀌지 않으면 마지막 상태로 한 번 보낸다 */
export function trackFilters(f: Filters) {
  if (!enabled) return;
  try {
    if (filterTimer !== null) window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => {
      filterTimer = null;
      track("filter_change", { props: filterProps(f) });
    }, FILTER_DEBOUNCE_MS);
  } catch {
    /* 무시 */
  }
}
