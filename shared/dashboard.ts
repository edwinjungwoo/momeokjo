// R57~R60 관리자 대시보드 v2: 지표 이름·정의, 응답 모양, 화면과 서버가 같이 쓰는 순수 계산.
// 화면(/admin 청크)도 부르므로 zod를 부르지 않는다.

/** 기간은 최대 90일 (KST, 오늘 포함 가능) */
export const DASHBOARD_MAX_DAYS = 90;
/** 일별 집계는 이벤트(90일)보다 길게 둔다 — 90일 기간의 이전 기간 비교까지 (익명 집계만 있다) */
export const DAILY_STATS_RETENTION_DAYS = 400;
/** Cron 한 번에 집계하는 날 수 (밀린 날을 오래된 날부터) */
export const ROLLUP_DAYS_PER_RUN = 3;
/** 밀린 날 따라잡기는 UTC 하루(D1 한도 하루)에 이만큼까지만 */
export const ROLLUP_MAX_DAYS_PER_UTC_DAY = 7;
/** 오늘(UTC) D1 읽기가 소프트 한도의 이만큼 이상이면 집계하지 않는다 (목록 서비스 몫을 남긴다) */
export const ROLLUP_BUDGET_SHARE = 0.3;
/** 집계가 실패한 날은 이만큼 지난 뒤에 다시 한다 (실패가 이어지면 두 배씩, 최대 ROLLUP_RETRY_MAX_MS) */
export const ROLLUP_RETRY_MS = 60 * 60_000;
export const ROLLUP_RETRY_MAX_MS = 24 * 60 * 60_000;
/** UTC 하루에 이만큼 실패하면 그날은 집계를 더 하지 않는다 */
export const ROLLUP_MAX_FAILURES_PER_UTC_DAY = 3;
/** 전날은 KST 이 시각 이후 첫 Cron에서 집계한다 (늦게 오는 이벤트 ±10분과 보관 정리 창에 맞춘다) */
export const ROLLUP_HOUR_KST = 4;
/** 아직 집계하지 않은 최근 날은 화면이 이만큼까지만 실시간으로 센다 (오늘, 새벽 4시 전이면 어제도) */
export const LIVE_MAX_DAYS = 2;
/** 거점·종류별로 날마다 남기는 상위 가게 수 (여러 날을 합친 Top 10은 이 근사로 만든다) */
export const TOP_PLACES_PER_DAY = 20;
export const TOP_PLACES_SHOWN = 10;
/** D1 무료 플랜 하루 한도 (UTC 자정 초기화) */
export const D1_DAILY_READ_LIMIT = 5_000_000;
export const D1_DAILY_WRITE_LIMIT = 100_000;
/** 게이지 색 경계 (소프트 한도 대비) */
export const BUDGET_THRESHOLDS = [0.5, 0.7, 0.9] as const;
/** 이상 신호를 띄우는 예산 사용률, 조작 버튼을 막는 사용률 */
export const BUDGET_ALERT_AT = 0.7;
export const BUDGET_BLOCK_AT = 0.9;
/** Cron이 이만큼 돌지 않았으면 이상 신호 */
export const CRON_STALE_MS = 15 * 60_000;
/** 결정까지 걸린 시간 구간의 위쪽 경계(초). 마지막 구간은 900초 이상 */
export const DECIDE_BUCKETS_SEC = [10, 30, 60, 120, 300, 900] as const;
export const DECIDE_METRICS = ["dt_lt10", "dt_lt30", "dt_lt60", "dt_lt120", "dt_lt300", "dt_lt900", "dt_ge900"] as const;
/** 재방문 비트 (anon_first_seen.ret) */
export const RETENTION_DAYS = [1, 7, 14, 28] as const;
/** 이번 작업에서 새로 모으기 시작한 값 (이 날짜 배포부터). 데이터가 없으면 화면이 "수집 시작: 날짜"를 보인다 */
export const COLLECT_SINCE = { confirmRank: "2026-10-07", relaxed: "2026-10-07" } as const;
/** R46 이유 라벨은 이벤트로 보내지 않는다 (화면은 "데이터 없음") */
export const REASONS_TRACKED = false;

export type BudgetLevel = "ok" | "notice" | "warn" | "crit";
/** 소프트 한도 대비 사용률 → 색 단계 (50 % 미만 ok, 70 % 미만 notice, 90 % 미만 warn, 그 위 crit) */
export function budgetLevel(fraction: number): BudgetLevel {
  const [a, b, c] = BUDGET_THRESHOLDS;
  if (!(fraction >= a)) return "ok";
  if (fraction < b) return "notice";
  if (fraction < c) return "warn";
  return "crit";
}

/**
 * R58 하루 지표 (거점별 + '*' 모든 거점). 이름 → 정의. 스펙 R58 표와 같아야 한다 (test/shared/dashboard.test.ts).
 * "세션"은 탭 세션 id, "결정"은 share(공유·복사, "여기로 가자고 공유" 포함) 또는 open_kakao(카카오맵 열기)다.
 */
export const METRICS = {
  users: "그날 app_open을 보낸 익명 id 수",
  new_users: "users 중 그날 이전 첫 방문 기록(anon_first_seen)이 없는 id 수",
  sessions: "app_open이 있는 세션 수",
  decided: "sessions 중 결정(share 또는 open_kakao)이 하나 이상인 세션 수",
  funnel_draw: "sessions 중 뽑기(draw·redraw, 자동 포함)가 있는 세션 수",
  funnel_draw_manual: "funnel_draw 중 직접 뽑기가 있는 세션 수",
  funnel_draw_auto_only: "funnel_draw 중 자동 뽑기만 있는 세션 수",
  funnel_expand: "funnel_draw 중 카드 펼침(expand_card)이 있는 세션 수",
  funnel_decide: "funnel_expand 중 결정이 있는 세션 수",
  funnel_share: "funnel_expand 중 share가 있는 세션 수",
  funnel_kakao: "funnel_expand 중 open_kakao가 있는 세션 수",
  funnel_confirm: "funnel_expand 중 \"여기로 가자고 공유\"(share, confirm)가 있는 세션 수",
  redraws_0: "뽑기가 있는 세션 중 직접 다시 뽑기(redraw)가 0번인 세션 수",
  redraws_1: "같은 기준, 1번",
  redraws_2: "같은 기준, 2번",
  redraws_3p: "같은 기준, 3번 이상",
  dt_lt10: "첫 뽑기 → 첫 결정이 10초 미만인 세션 수 (결정이 첫 뽑기 뒤인 세션만)",
  dt_lt30: "같은 기준, 10~30초",
  dt_lt60: "같은 기준, 30~60초",
  dt_lt120: "같은 기준, 1~2분",
  dt_lt300: "같은 기준, 2~5분",
  dt_lt900: "같은 기준, 5~15분",
  dt_ge900: "같은 기준, 15분 이상",
  auto_sessions: "첫 뽑기가 자동 뽑기인 세션 수 (직접 뽑기 뒤에 온 자동 뽑기는 뺀다)",
  auto_accepted: "auto_sessions 중 첫 자동 뽑기 뒤 직접 뽑기 전에 결정한 세션 수",
  auto_redrawn: "auto_sessions 중 수용이 아니고 첫 자동 뽑기 뒤 직접 뽑기가 있는 세션 수",
  auto_left: "auto_sessions 중 결정도 직접 뽑기도 없는 세션 수 (닫기는 따로 보내지 않아 이것으로 본다)",
  link_sessions: "받은 공유 링크를 연(share_open) 세션 수",
  reshare_sessions: "link_sessions 중 share도 한 세션 수",
  draw_manual: "직접 한 draw 이벤트 수",
  redraw: "직접 한 redraw 이벤트 수",
  draw_auto: "자동 뽑기(props.auto) 이벤트 수",
  draw_relaxed: "R41 완화가 섞인 뽑기(props.relaxed) 이벤트 수",
  share: "share 이벤트 수 (확정 공유 포함)",
  share_confirm: "\"여기로 가자고 공유\" 확정 공유(props.confirm) 이벤트 수",
  open_kakao: "open_kakao 이벤트 수",
  share_open: "받은 공유 링크 열림(share_open) 이벤트 수",
  expand: "expand_card 이벤트 수",
  exclude: "exclude_place(\"다음부터 안 보기\") 이벤트 수",
  undo_exclude: "undo_exclude 이벤트 수",
  select_place: "select_place 이벤트 수",
  hub_change: "hub_change 이벤트 수",
  filter_change: "filter_change 이벤트 수",
  empty_result: "empty_result 이벤트 수",
  events: "그날 저장된 모든 이벤트 수",
  f_total: "filter_change 스냅숏 수 (필터 분포의 분모)",
} as const;
export type MetricName = keyof typeof METRICS;

/** 이름 뒤에 값이 붙는 지표 묶음. 접두어 → 정의 (스펙 R58 표와 같아야 한다) */
export const METRIC_FAMILIES = {
  sessions_h: "sessions_h{00~23}: app_open의 KST 시(0~23)별 세션 수 (요일 × 시간 히트맵)",
  expand_r: "expand_r{1~3}: 결과 카드 번호별 expand_card 수",
  kakao_r: "kakao_r{1~3}: 결과 카드 번호별 open_kakao 수",
  exclude_r: "exclude_r{1~3}: 결과 카드 번호별 exclude_place 수",
  confirm_r: "confirm_r{1~3}: 결과 카드 번호별 \"여기로 가자고 공유\" 수 (props.rank, 이번 배포부터)",
  f_party_: "f_party_{1~4}: filter_change 스냅숏의 인원",
  f_group_: "f_group_{그룹 id | all}: 스냅숏에 고른 종류 (all = 아무것도 고르지 않음 = 전체)",
  f_price_: "f_price_{all|10000|15000|20000}: 스냅숏의 예산",
  f_rating_: "f_rating_{0|3.5|4}: 스냅숏의 최소 평점",
  f_open_: "f_open_{1|0}: 스냅숏의 영업 중만",
  f_radius_: "f_radius_{300|500|700|1000}: 스냅숏 반경 구간 (≤300, ≤500, ≤700, ≤1000m)",
  "pick:": "pick:{가게 id}: 직접 뽑기 결과(picks)에 나온 횟수 — 거점마다 그날 상위 20곳만",
  "share:": "share:{가게 id}: share의 picks에 나온 횟수 — 상위 20곳만",
  "excl:": "excl:{가게 id}: \"다음부터 안 보기\" 횟수 — 상위 20곳만",
  cohort_: "cohort_{size|d1|d7|d14|d28}: day = 첫 방문 주 월요일, 그 주에 처음 온 id 수와 그중 Dn 재방문 수",
} as const;

export const COHORT_METRICS = ["cohort_size", "cohort_d1", "cohort_d7", "cohort_d14", "cohort_d28"] as const;

/** 지표 이름이 정의돼 있는가 (고정 이름 또는 묶음 접두어) */
export const isKnownMetric = (m: string): boolean =>
  m in METRICS || Object.keys(METRIC_FAMILIES).some((p) => m.startsWith(p));

// ── 날짜 (KST yyyy-mm-dd 문자열) ─────────────────────────────

const DAY = 86_400_000;
const toMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => fromMs(toMs(day) + n * DAY);
export const daysBetween = (from: string, to: string) => Math.round((toMs(to) - toMs(from)) / DAY);
/** [from, to] 날짜 목록 (to < from이면 빈 목록) */
export function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
/** 월요일 0 … 일요일 6 */
export const weekdayOf = (day: string) => (new Date(toMs(day)).getUTCDay() + 6) % 7;
export const mondayOf = (day: string) => addDays(day, -weekdayOf(day));
export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && fromMs(toMs(s)) === s;

// ── 계산 ─────────────────────────────

export const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** 이전 기간 대비 증감률 (이전이 0이거나 없으면 null) */
export function deltaOf(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return (cur - prev) / Math.abs(prev);
}

/**
 * 구간 히스토그램의 중앙값(초) 근사: 중앙이 들어간 구간 안에서 선형 보간한다. 마지막(열린) 구간이면 그 아래 경계.
 * counts는 DECIDE_METRICS 순서, 합이 0이면 null
 */
export function histogramMedian(counts: readonly number[], bounds: readonly number[] = DECIDE_BUCKETS_SEC): number | null {
  const total = counts.reduce((s, x) => s + x, 0);
  if (total <= 0) return null;
  const half = total / 2;
  let acc = 0;
  for (let i = 0; i < counts.length; i++) {
    const lo = i === 0 ? 0 : bounds[i - 1];
    if (acc + counts[i] >= half && counts[i] > 0) {
      if (i >= bounds.length) return lo;
      const hi = bounds[i];
      return lo + ((half - acc) / counts[i]) * (hi - lo);
    }
    acc += counts[i];
  }
  return bounds[bounds.length - 1];
}

// ── 응답 모양 (GET /api/admin/dashboard) ─────────────────────────────

export type DashboardTab = "overview" | "behavior" | "ops";
export type Metrics = Record<string, number>;

export type DashboardRange = { from: string; to: string; days: number; hub: string; compare: boolean };
/** 기간의 날마다 어디서 왔는지: 집계(rollup), 실시간(live), 아직 없음(missing — 밀린 집계를 Cron이 채우는 중) */
export type DaySource = "rollup" | "live" | "missing";

export type DashboardBase = {
  tab: DashboardTab;
  range: DashboardRange;
  /** 비교한 앞 기간 (비교 끔이거나 오늘만 고른 기간이면 null) */
  prev: { from: string; to: string } | null;
  /** R57 기간에 오늘이 있어 비교에서 오늘(과 앞 기간의 같은 자리 하루)을 뺐다 */
  compareExcludesToday: boolean;
  /** 서버 시각 (epoch ms) */
  now: number;
  today: string;
  /** Cron이 집계를 마친 마지막 날 (없으면 null) */
  rollupThrough: string | null;
  sources: Record<string, DaySource>;
};

/** value: 기간 값, cmp: 비교에 쓰는 현재 값(오늘 뺀 날들), prev: 앞 기간 값, spark: 기간 끝에서 14일 */
export type Kpi = { value: number | null; cmp: number | null; prev: number | null; spark: (number | null)[] };
export type Alert = { level: "info" | "warn" | "crit"; code: string; text: string };

export type OverviewData = DashboardBase & {
  tab: "overview";
  kpis: {
    /** 하루면 그날 사용자, 여러 날이면 일평균 사용자 (기간 고유 사용자는 날마다 합칠 수 없다) */
    users: Kpi;
    newUsers: Kpi;
    sessions: Kpi;
    decisionRate: Kpi;
    drawsPerSession: Kpi;
    shareOpens: Kpi;
  };
  daily: { day: string; source: DaySource; manual: number; auto: number; users: number; sessions: number; decided: number }[];
  /** [요일 월~일][KST 시 0~23] 세션 시작 수 */
  heatmap: number[][];
  hubs: { hub: string; users: number; sessions: number; decided: number; draws: number; shares: number }[];
  alerts: Alert[];
};

export type TopPlace = { placeId: string; name: string | null; count: number };
/** ret: D1·D7·D14·D28 재방문 수(주 첫날 + n일이 아직 안 지났으면 null), partial: 주 마지막 날 + n일은 아직 안 지나 일부만 관찰한 칸 */
export type Cohort = { week: string; size: number; ret: (number | null)[]; partial: boolean[] };

export type BehaviorData = DashboardBase & {
  tab: "behavior";
  /** 기간 합계 지표 (cohort·가게 제외) */
  totals: Metrics;
  /** 비교에 쓰는 현재 합계 (오늘을 뺀 날들, 비교 끔이면 null) */
  cmpTotals: Metrics | null;
  prevTotals: Metrics | null;
  /** 새로 모으는 값이 집계에 처음 나온 날 (없으면 null — 화면은 COLLECT_SINCE로 대신) */
  collectSince: { relaxed: string | null; confirmRank: string | null };
  cohorts: Cohort[];
  places: { picked: TopPlace[]; shared: TopPlace[]; excluded: TopPlace[] };
};

export type HubStatus = {
  hub: string;
  places: number;
  ok: number;
  failed: number;
  pending: number;
  visible: number;
  listReady: number;
  tiles: number;
  incompleteTiles: number;
  saturatedTiles: number;
  oldestOkAt: number | null;
  lastTileAt: number | null;
  /** R63 갱신 요일 (KST, 0=일 ~ 6=토) */
  refreshDay: number;
  /** R63 이번 갱신 시작 (그 요일 00:00 KST, epoch ms) */
  refreshStart: number;
  /** R63 마지막 완료 시각과 그때 끝낸 갱신의 시작 (없으면 null) — refreshedStart가 refreshStart와 같으면 이번 갱신을 끝냈다 */
  refreshedAt: number | null;
  refreshedStart: number | null;
  /** R63 남은 갱신: due_after(R66)가 이번 시작 전인 ok 상세 수 (미수집은 pending, 실패는 failed로 따로) */
  due: number;
  /**
   * R66 주기 분포 몫: 이 거점이 주인인 칸(HUBS 순서로 처음 덮는 거점)의 ok 가게를 주기(1·2·4주)로 센 것 — 모든 거점을 더하면
   * 거점 격자 가게마다 한 번 (intervalsOf). 예전 캐시 값에는 없다
   */
  ownIntervals?: IntervalCount[];
};
export type CronSummary = {
  at: number;
  collected: number;
  incomplete: number;
  enriched: number;
  failed: number;
  calls: number;
  rolled: number;
  skipped?: string;
  /** Task 34: 보충 저장 오류가 있었다 (센 수는 그대로, 원인은 Workers 로그) */
  enrichError?: true;
  /** Task 34: D1 호출 예산 때문에 건너뛴 단계 (expired·unfetched·rollup) */
  d1Skipped?: string[];
};
export type OpsSnapshot = {
  budget: {
    utcDay: string;
    read: number;
    written: number;
    readSoftCap: number;
    writeSoftCap: number;
    /** 다음 초기화 시각 (00:00 UTC = 09:00 KST, epoch ms) */
    resetAt: number;
  };
  kakao: {
    blockedUntil: number;
    frozen: { since: number; until: number } | null;
    blocksToday: number;
  };
  cron: CronSummary | null;
  /** R63: 둘째 트리거의 상세만 실행(홀수 분) 마지막 요약 (격자·집계는 늘 0) */
  cronDetail?: CronSummary | null;
  /** R66: 최근 7일(UTC 날짜, 오늘 포함, 오래된 날부터) 저장한 상세를 지난 지문과 비교한 수 (meta detail_*:{날짜}) */
  details?: DetailDay[];
};

/** R66 하루 계수: same 지문이 같음(주기 늘림), changed 바뀜(주기 1주로), first 지난 지문 없음(새 가게·0008 뒤 첫 갱신) */
export type DetailDay = { day: string; same: number; changed: number; first: number };
/** R66 주기 분포: ok 가게 중 interval_weeks가 weeks인 곳 수 */
export type IntervalCount = { weeks: number; places: number };

/** R66 주기 분포: 거점마다의 몫(ownIntervals)을 더한다 — 0곳인 주기는 빼고 주기 순. 거점 상태를 세지 않았으면 null */
export function intervalsOf(hubs: readonly HubStatus[] | null): IntervalCount[] | null {
  if (!hubs) return null;
  const sum = new Map<number, number>();
  for (const h of hubs) for (const x of h.ownIntervals ?? []) sum.set(x.weeks, (sum.get(x.weeks) ?? 0) + x.places);
  return [...sum].filter(([, n]) => n > 0).sort((a, b) => a[0] - b[0]).map(([weeks, places]) => ({ weeks, places }));
}

/** R66 운영 탭 표: 다시 가져온 수 = same + changed, 바뀐 비율 = changed ÷ 다시 가져온 수 (없으면 null), 처음은 따로 + 합계 */
export function detailRefreshSummary(days: readonly DetailDay[]) {
  const row = (same: number, changed: number, first: number) => ({
    refreshed: same + changed, changed, first, changedRate: ratio(changed, same + changed),
  });
  const sum = (k: "same" | "changed" | "first") => days.reduce((n, d) => n + d[k], 0);
  return {
    days: days.map((d) => ({ day: d.day, ...row(d.same, d.changed, d.first) })),
    total: row(sum("same"), sum("changed"), sum("first")),
  };
}

export type OpsData = DashboardBase & {
  tab: "ops";
  ops: OpsSnapshot;
  /** 거점별 데이터 상태 (오늘 읽기가 소프트 한도의 절반을 넘었고 캐시에도 없으면 null — 계산하지 않았다) */
  hubs: HubStatus[] | null;
  hubsComputedAt: number | null;
  /** 오늘(KST) 저장된 이벤트 수 (실시간 집계에서), 모르면 null */
  eventsToday: number | null;
  /** R66 주기 분포(1·2·4주, 주기 순 — 거점 격자 가게마다 한 번)와 센 시각 = 거점 상태(15분 캐시)와 같이. 세지 않았으면 null */
  intervals: IntervalCount[] | null;
  intervalsAt: number | null;
  alerts: Alert[];
};

export type DashboardResponse = OverviewData | BehaviorData | OpsData;

/** 예산 사용률: 읽기·쓰기 중 소프트 한도에 더 가까운 쪽 */
export const budgetFraction = (b: OpsSnapshot["budget"]) =>
  Math.max(b.read / Math.max(1, b.readSoftCap), b.written / Math.max(1, b.writeSoftCap));

/** R60 운영 조작 중: 이번 조작이 읽고 쓴 행까지 더하면 예산 사용률이 잠금선(90 %) 이상인가 */
export const overBlockAfter = (b: OpsSnapshot["budget"], read: number, written: number) =>
  budgetFraction({ ...b, read: b.read + read, written: b.written + written }) >= BUDGET_BLOCK_AT;

/**
 * R57 "오늘의 이상 신호". 순서: 심각한 것 먼저.
 * 예산 > 70 %(소프트 한도 대비), 상세 쿨다운·frozen, pending > 0이거나 미완료 격자가 있는 거점, 15분 넘게 Cron이 돌지 않음, 집계 밀림
 * R62: 준비 중 거점은 아직 모으는 중이라 미수집·미완료가 당연하다 → 이름 뒤에 "(준비 중)"을 붙이고 참고 신호 중에서도 맨 뒤로 보낸다
 */
export function alertsOf(
  ops: OpsSnapshot, hubs: HubStatus[] | null, now: number, rollup: { through: string | null; yesterday: string },
  hubName: (id: string) => string = (id) => id,
  isUnready: (id: string) => boolean = () => false,
): Alert[] {
  const out: Alert[] = [];
  const f = budgetFraction(ops.budget);
  if (f >= BUDGET_ALERT_AT) {
    out.push({
      level: f >= BUDGET_BLOCK_AT ? "crit" : "warn",
      code: "budget",
      text: `오늘 D1 사용량이 소프트 한도의 ${Math.round(f * 100)}%예요`,
    });
  }
  const frozen = ops.kakao.frozen && now < ops.kakao.frozen.until ? ops.kakao.frozen : null;
  if (frozen) out.push({ level: "crit", code: "frozen", text: "상세 가져오기가 하루 멈춤(frozen) 상태예요" });
  else if (now < ops.kakao.blockedUntil) out.push({ level: "warn", code: "cooldown", text: "상세 가져오기가 쿨다운 중이에요" });
  if (!ops.cron) out.push({ level: "warn", code: "cron", text: "Cron 실행 기록이 아직 없어요" });
  else if (now - ops.cron.at > CRON_STALE_MS) {
    out.push({ level: "crit", code: "cron", text: `Cron이 ${Math.round((now - ops.cron.at) / 60_000)}분째 돌지 않았어요` });
  }
  for (const h of hubs ?? []) {
    if (h.pending > 0 || h.incompleteTiles > 0) {
      const parts = [h.pending > 0 ? `미수집 ${h.pending}곳` : "", h.incompleteTiles > 0 ? `미완료 격자 ${h.incompleteTiles}칸` : ""];
      const tag = isUnready(h.hub) ? " (준비 중)" : "";
      out.push({ level: "info", code: `hub:${h.hub}`, text: `${hubName(h.hub)}${tag}: ${parts.filter(Boolean).join(", ")}` });
    }
  }
  if (rollup.through === null || rollup.through < addDays(rollup.yesterday, -1)) {
    out.push({ level: "info", code: "rollup", text: "지난 날 집계를 Cron이 채우는 중이에요" });
  }
  const rank = { crit: 0, warn: 1, info: 2 } as const;
  const unreadyHub = (a: Alert) => (a.code.startsWith("hub:") && isUnready(a.code.slice(4)) ? 1 : 0);
  return out.sort((a, b) => rank[a.level] - rank[b.level] || unreadyHub(a) - unreadyHub(b));
}
