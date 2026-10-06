import { PREWARM_RADIUS, TILE_TTL_MS } from "../shared/constants";
import {
  COHORT_METRICS, LIVE_MAX_DAYS, METRICS, RETENTION_DAYS, TOP_PLACES_SHOWN, addDays, alertsOf, dayList, mondayOf, ratio,
  weekdayOf, type BehaviorData, type Cohort, type CronSummary, type DashboardBase, type DashboardRange, type DashboardTab,
  type DaySource, type HubStatus, type Kpi, type Metrics, type OpsData, type OpsSnapshot, type OverviewData, type TopPlace,
} from "../shared/dashboard";
import { tilesCoveringCircle } from "../shared/geo";
import { HUBS, hubById } from "../shared/hubs";
import { kstDay, utcDay } from "../shared/kst";
import { CRON_LAST_KEY } from "./d1Usage";
import { usableListJsonSql } from "./present";
import { COLLECT_SINCE_KEYS, ROLLUP_THROUGH_KEY, liveDayMetrics, type LivePart, type MetricRow } from "./rollup";

/**
 * R57~R60 GET /api/admin/dashboard. 탭 하나에 필요한 것을 한 응답으로 준다.
 * 읽는 것: 일별 집계(daily_stats, 집계를 마친 날) + 아직 집계하지 않은 오늘(·새벽 4시 전이면 어제)의 실시간 집계(5분 엣지 캐시, 탭·거점 공용)
 * + meta 몇 행 + 거점별 데이터 상태(15분 엣지 캐시). events를 30·90일씩 훑지 않는다.
 */
export type JsonCache = {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
};
export type DashboardDeps = {
  db: D1Database;
  cache?: JsonCache;
  now: number;
  readSoftCap: number;
  writeSoftCap: number;
  defer: (p: Promise<unknown>) => void;
  /** 거점 상태 캐시를 건너뛴다 (조작 직후 새로 보기) */
  fresh?: boolean;
};
export type DashboardQuery = { tab: DashboardTab; from: string; to: string; hub: string; compare: boolean };

/** 응답 형식이 바뀌면 올린다 */
export const DASHBOARD_CACHE_VERSION = "1";
export const DASHBOARD_CACHE_MS = 60_000;
/**
 * 실시간 집계(그날 events를 이벤트당 수 행씩 읽는다)는 탭·거점이 함께 쓰고 5분 둔다 — 자동 새로고침(60초)이 매번 다시 세지 않게.
 * 오늘 읽기가 소프트 한도의 LIVE_BUDGET_SHARE를 넘으면 아예 세지 않는다 (목록 서비스 몫을 남긴다)
 */
export const LIVE_CACHE_MS = 5 * 60_000;
export const LIVE_BUDGET_SHARE = 0.5;
/** 거점별 데이터 상태(격자·가게 수천 행)는 천천히 바뀐다 */
export const HUB_STATUS_CACHE_MS = 15 * 60_000;
const EXPIRES = "x-mmj-expires";

export const dashboardCacheKey = (q: DashboardQuery) =>
  `https://cache.mmj/admin/dashboard?tab=${q.tab}&from=${q.from}&to=${q.to}&hub=${encodeURIComponent(q.hub)}&compare=${q.compare ? 1 : 0}&v=${DASHBOARD_CACHE_VERSION}`;
const liveKey = (day: string, part: LivePart) => `https://cache.mmj/admin/live?day=${day}&part=${part}&v=${DASHBOARD_CACHE_VERSION}`;
const HUBS_KEY = `https://cache.mmj/admin/hubs?v=${DASHBOARD_CACHE_VERSION}`;

/** 엣지 캐시에 둔 JSON (만료 시각은 헤더로 직접 본다). 없거나 지났으면 null */
export async function cachedJson<T>(cache: JsonCache | undefined, key: string, now: number): Promise<T | null> {
  const hit = await cache?.match(new Request(key));
  if (!hit || !(Number(hit.headers.get(EXPIRES)) > now)) return null;
  return (await hit.json()) as T;
}
export function putJson(deps: Pick<DashboardDeps, "cache" | "defer">, key: string, body: string, now: number, ttlMs: number) {
  if (!deps.cache) return;
  const res = new Response(body, {
    headers: {
      "content-type": "application/json",
      // Workers Cache API는 private 응답을 저장하지 않는다 — 내부 키(cache.mmj)라 public으로 둔다 (브라우저 응답은 따로 no-store)
      "cache-control": `public, max-age=${Math.round(ttlMs / 1000)}, s-maxage=${Math.round(ttlMs / 1000)}`,
      [EXPIRES]: String(now + ttlMs),
    },
  });
  deps.defer(deps.cache.put(new Request(key), res).catch((e) => console.error("cache put failed", e)));
}

// ── meta ─────────────────────────────

type MetaState = { ops: OpsSnapshot; rollupThrough: string | null; collectSince: BehaviorData["collectSince"] };

async function readState(deps: DashboardDeps): Promise<MetaState> {
  const day = utcDay(deps.now);
  const keys = [
    `d1_read:${day}`, `d1_written:${day}`, "place_blocked_until", "detail_mode", `block_count:${kstDay(deps.now)}`, CRON_LAST_KEY,
    ROLLUP_THROUGH_KEY,
    COLLECT_SINCE_KEYS.relaxed,
    COLLECT_SINCE_KEYS.confirmRank,
  ];
  const r = await deps.db
    .prepare(`SELECT key, value FROM meta WHERE key IN (${keys.map(() => "?").join(", ")})`)
    .bind(...keys)
    .all<{ key: string; value: string }>();
  const get = (k: string) => r.results.find((x) => x.key === k)?.value;
  const num = (k: string) => {
    const v = Number(get(k) ?? 0);
    return Number.isFinite(v) ? v : 0;
  };
  let frozen: OpsSnapshot["kakao"]["frozen"] = null;
  let cron: CronSummary | null = null;
  try {
    const m = JSON.parse(get("detail_mode") ?? "null") as { mode?: string; since?: number; until?: number } | null;
    if (m?.mode === "frozen" && typeof m.since === "number" && typeof m.until === "number") frozen = { since: m.since, until: m.until };
  } catch {
    /* 깨진 값은 없는 것으로 */
  }
  try {
    const c = JSON.parse(get(CRON_LAST_KEY) ?? "null") as CronSummary | null;
    if (c && typeof c.at === "number") cron = c;
  } catch {
    /* 깨진 값은 없는 것으로 */
  }
  const nextUtcMidnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
  return {
    ops: {
      budget: {
        utcDay: day, read: num(keys[0]), written: num(keys[1]), readSoftCap: deps.readSoftCap, writeSoftCap: deps.writeSoftCap,
        resetAt: nextUtcMidnight,
      },
      kakao: { blockedUntil: num("place_blocked_until"), frozen, blocksToday: num(keys[4]) },
      cron,
    },
    rollupThrough: get(ROLLUP_THROUGH_KEY) ?? null,
    collectSince: { relaxed: get(COLLECT_SINCE_KEYS.relaxed) ?? null, confirmRank: get(COLLECT_SINCE_KEYS.confirmRank) ?? null },
  };
}

const liveAllowedBy = (state: MetaState, deps: DashboardDeps) => state.ops.budget.read < deps.readSoftCap * LIVE_BUDGET_SHARE;

// ── 지표 저장소 (날 → 거점 → 지표) ─────────────────────────────

type Store = Map<string, Map<string, Metrics>>;
const hubKey = (hub: string) => (hub === "all" ? "*" : hub);

function put(store: Store, day: string, hub: string, metric: string, value: number) {
  let byHub = store.get(day);
  if (!byHub) store.set(day, (byHub = new Map()));
  let m = byHub.get(hub);
  if (!m) byHub.set(hub, (m = {}));
  m[metric] = (m[metric] ?? 0) + value;
}

/** 날마다 출처: 집계를 마쳤으면 rollup, 오늘·어제(LIVE_MAX_DAYS)이고 실시간이 허용되면 live, 아니면 missing */
function sourceOf(day: string, today: string, through: string | null, liveAllowed: boolean): DaySource {
  if (through !== null && day <= through) return "rollup";
  if (liveAllowed && day <= today && day > addDays(today, -LIVE_MAX_DAYS)) return "live";
  return "missing";
}

type RollupQuery = { days: string[]; hubs: string[]; metrics?: readonly string[] };

/** daily_stats를 (day, hub, metric) 기본 키로 콕 집어 읽는다 — json_each 목록이라 매개변수 100개 제한에 걸리지 않는다 */
function rollupStatement(db: D1Database, q: RollupQuery): D1PreparedStatement {
  const metric = q.metrics ? " AND metric IN (SELECT value FROM json_each(?3))" : "";
  const stmt = db.prepare(
    `SELECT day, hub, metric, value FROM daily_stats
     WHERE day IN (SELECT value FROM json_each(?1)) AND hub IN (SELECT value FROM json_each(?2))${metric}`,
  );
  const args = [JSON.stringify(q.days), JSON.stringify(q.hubs)];
  return q.metrics ? stmt.bind(...args, JSON.stringify(q.metrics)) : stmt.bind(...args);
}

async function liveRows(deps: DashboardDeps, day: string, part: LivePart): Promise<MetricRow[]> {
  const key = liveKey(day, part);
  const hit = await cachedJson<MetricRow[]>(deps.cache, key, deps.now);
  if (hit) return hit;
  const rows = await liveDayMetrics(deps.db, day, part);
  putJson(deps, key, JSON.stringify(rows), deps.now, LIVE_CACHE_MS);
  return rows;
}

/**
 * 필요한 날들의 지표를 모은다. rollup 날은 질의(batch 한 번)로, live 날은 실시간 집계(캐시)로.
 * queries는 rollup 날만 남겨서 읽는다. live 날은 hubs에 든 거점 것만 담는다.
 */
async function collect(
  deps: DashboardDeps, sources: Map<string, DaySource>, queries: RollupQuery[], liveHubs: Set<string> | null,
  parts: LivePart[] = ["core"],
): Promise<Store> {
  const store: Store = new Map();
  const stmts = queries
    .map((q) => ({ ...q, days: q.days.filter((d) => sources.get(d) === "rollup") }))
    .filter((q) => q.days.length > 0)
    .map((q) => rollupStatement(deps.db, q));
  const liveDays = [...sources].filter(([, s]) => s === "live").map(([d]) => d);
  const [rolled, lives] = await Promise.all([
    stmts.length > 0 ? deps.db.batch<{ day: string; hub: string; metric: string; value: number }>(stmts) : Promise.resolve([]),
    Promise.all(liveDays.map(async (d) => [d, (await Promise.all(parts.map((p) => liveRows(deps, d, p)))).flat()] as const)),
  ]);
  const seen = new Set<string>();
  for (const r of rolled) {
    for (const x of r.results) {
      // 두 질의가 같은 행을 읽었으면 한 번만 더한다
      const id = `${x.day}|${x.hub}|${x.metric}`;
      if (seen.has(id)) continue;
      seen.add(id);
      put(store, x.day, x.hub, x.metric, Number(x.value));
    }
  }
  for (const [d, rows] of lives) {
    for (const x of rows) if (!liveHubs || liveHubs.has(x.hub)) put(store, d, x.hub, x.metric, x.value);
  }
  return store;
}

const metricOf = (store: Store, day: string, hub: string, m: string) => store.get(day)?.get(hub)?.[m] ?? 0;

// ── 거점별 데이터 상태 ─────────────────────────────

const HUB_TILES = `WITH k AS (SELECT json_extract(value, '$[0]') AS hub, json_extract(value, '$[1]') AS key FROM json_each(?1))`;
const HUB_PLACES_SQL = `${HUB_TILES},
tp AS MATERIALIZED (SELECT DISTINCT k.hub AS hub, t.place_id AS id FROM k JOIN tile_places t ON t.tile_key = k.key)
SELECT tp.hub AS hub, count(*) AS places,
  count(CASE WHEN p.status = 'ok' THEN 1 END) AS ok,
  count(CASE WHEN p.status = 'failed' THEN 1 END) AS failed,
  count(CASE WHEN p.id IS NULL THEN 1 END) AS pending,
  count(CASE WHEN p.name IS NOT NULL AND p.lat IS NOT NULL AND p.lng IS NOT NULL THEN 1 END) AS visible,
  count(CASE WHEN p.name IS NOT NULL AND p.lat IS NOT NULL AND p.lng IS NOT NULL AND ${usableListJsonSql("p.list_json")} THEN 1 END) AS listReady,
  min(CASE WHEN p.status = 'ok' THEN p.fetched_at END) AS oldestOkAt
FROM tp LEFT JOIN places p ON p.id = tp.id GROUP BY tp.hub`;
const HUB_TILES_SQL = `${HUB_TILES}
SELECT k.hub AS hub, count(*) AS tiles,
  count(CASE WHEN t.key IS NULL OR t.collected_at <= ?2 THEN 1 END) AS incompleteTiles,
  count(CASE WHEN t.saturated = 1 THEN 1 END) AS saturatedTiles,
  max(t.collected_at) AS lastTileAt
FROM k LEFT JOIN tiles t ON t.key = k.key GROUP BY k.hub`;

/** R60 거점마다: 가게 수, 상세 성공·실패·미수집, 목록에 보이는 곳·list_json 준비, 가장 오래된 상세, 격자 수·미완료(없거나 7일 지남)·포화, 마지막 격자 수집 */
export async function hubStatuses(db: D1Database, now: number): Promise<HubStatus[]> {
  const pairs = JSON.stringify(HUBS.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS).map((k) => [h.id, k])));
  const [places, tiles] = await db.batch<Record<string, number | string | null>>([
    db.prepare(HUB_PLACES_SQL).bind(pairs),
    db.prepare(HUB_TILES_SQL).bind(pairs, now - TILE_TTL_MS),
  ]);
  const num = (v: unknown) => Number(v ?? 0) || 0;
  const orNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return HUBS.map((h) => {
    const p = places.results.find((x) => x.hub === h.id) ?? {};
    const t = tiles.results.find((x) => x.hub === h.id) ?? {};
    return {
      hub: h.id,
      places: num(p.places), ok: num(p.ok), failed: num(p.failed), pending: num(p.pending), visible: num(p.visible),
      listReady: num(p.listReady), oldestOkAt: orNull(p.oldestOkAt),
      tiles: num(t.tiles), incompleteTiles: num(t.incompleteTiles), saturatedTiles: num(t.saturatedTiles), lastTileAt: orNull(t.lastTileAt),
    };
  });
}

/** 거점 상태: 캐시에 있으면 그것, 없으면 계산 — 단 오늘 읽기가 실시간 가드(LIVE_BUDGET_SHARE)를 넘었으면 계산하지 않는다(null) */
async function cachedHubStatuses(deps: DashboardDeps, allowed: boolean): Promise<{ hubs: HubStatus[] | null; at: number | null }> {
  if (!deps.fresh || !allowed) {
    const hit = await cachedJson<{ hubs: HubStatus[]; at: number }>(deps.cache, HUBS_KEY, deps.now);
    if (hit) return hit;
  }
  if (!allowed) return { hubs: null, at: null };
  const v = { hubs: await hubStatuses(deps.db, deps.now), at: deps.now };
  putJson(deps, HUBS_KEY, JSON.stringify(v), deps.now, HUB_STATUS_CACHE_MS);
  return v;
}

// ── 탭 ─────────────────────────────

const KPI_METRICS = ["users", "new_users", "sessions", "decided", "draw_manual", "redraw", "draw_auto", "share", "share_open"] as const;
const HOUR_METRICS = Array.from({ length: 24 }, (_, h) => `sessions_h${String(h).padStart(2, "0")}`);
const SPARK_DAYS = 14;
const hubName = (id: string) => (HUBS.some((h) => h.id === id) ? hubById(id).name : id);

type CompareDays = { cur: string[]; prev: string[]; excludesToday: boolean };

/**
 * R57 이전 기간 비교에 쓰는 날: 기간에 오늘(아직 끝나지 않은 날)이 있으면 오늘을 빼고(cur), 같은 길이의 바로 앞 기간도 그만큼(prev).
 * 오늘만 고른 기간은 비교하지 않는다 (cur·prev 모두 빈 목록)
 */
function compareDays(q: DashboardQuery, today: string, rangeDays: string[]): CompareDays {
  if (!q.compare) return { cur: [], prev: [], excludesToday: false };
  const excludesToday = q.to === today;
  const cur = excludesToday ? rangeDays.slice(0, -1) : rangeDays;
  const prev = dayList(addDays(q.from, -rangeDays.length), addDays(q.from, -1)).slice(0, cur.length);
  return { cur, prev, excludesToday };
}

function base(
  q: DashboardQuery, now: number, through: string | null, sources: Map<string, DaySource>, rangeDays: string[], cmp?: CompareDays,
): DashboardBase {
  const days = rangeDays.length;
  const range: DashboardRange = { from: q.from, to: q.to, days, hub: q.hub, compare: q.compare };
  return {
    tab: q.tab,
    range,
    prev: cmp && cmp.prev.length > 0 ? { from: cmp.prev[0], to: cmp.prev[cmp.prev.length - 1] } : null,
    compareExcludesToday: cmp?.excludesToday ?? false,
    now,
    today: kstDay(now),
    rollupThrough: through,
    sources: Object.fromEntries(rangeDays.map((d) => [d, sources.get(d) ?? "missing"])),
  };
}

function sourcesFor(days: Iterable<string>, today: string, through: string | null, liveAllowed: boolean) {
  const m = new Map<string, DaySource>();
  for (const d of days) m.set(d, sourceOf(d, today, through, liveAllowed));
  return m;
}

/** 여러 날의 KPI 값 (missing 날은 빼고, 셀 날이 없으면 null) */
function kpiValues(store: Store, days: string[], hub: string, sources: Map<string, DaySource>) {
  const counted = days.filter((d) => sources.get(d) !== "missing");
  if (counted.length === 0) return null;
  const sum = (m: string) => counted.reduce((s, d) => s + metricOf(store, d, hub, m), 0);
  const sessions = sum("sessions");
  return {
    users: sum("users") / counted.length,
    newUsers: sum("new_users"),
    sessions,
    decisionRate: ratio(sum("decided"), sessions),
    drawsPerSession: ratio(sum("draw_manual") + sum("redraw"), sessions),
    shareOpens: sum("share_open"),
  };
}

async function overview(deps: DashboardDeps, q: DashboardQuery, state: MetaState): Promise<OverviewData> {
  const today = kstDay(deps.now);
  const liveAllowed = liveAllowedBy(state, deps);
  const rangeDays = dayList(q.from, q.to);
  const sparkDays = dayList(addDays(q.to, -(SPARK_DAYS - 1)), q.to);
  const cmp = compareDays(q, today, rangeDays);
  const prevDays = cmp.prev;
  const key = hubKey(q.hub);
  const hubKeys = q.hub === "all" ? ["*", ...HUBS.map((h) => h.id)] : [key];
  const extra = [...new Set([...sparkDays, ...prevDays])].filter((d) => d < q.from || d > q.to);
  const sources = sourcesFor([...rangeDays, ...extra], today, state.rollupThrough, liveAllowed);
  const [store, hubs] = await Promise.all([
    collect(
      deps, sources,
      [
        { days: rangeDays, hubs: hubKeys, metrics: [...KPI_METRICS, ...HOUR_METRICS] },
        { days: extra, hubs: [key], metrics: KPI_METRICS },
      ],
      new Set(hubKeys),
    ),
    cachedHubStatuses(deps, liveAllowed),
  ]);

  const cur = kpiValues(store, rangeDays, key, sources);
  const prev = q.compare ? kpiValues(store, prevDays, key, sources) : null;
  const cur2 = q.compare ? kpiValues(store, cmp.cur, key, sources) : null;
  const spark = (pick: (v: NonNullable<ReturnType<typeof kpiValues>>) => number | null) =>
    sparkDays.map((d) => {
      const v = kpiValues(store, [d], key, sources);
      return v ? pick(v) : null;
    });
  const kpi = (pick: (v: NonNullable<ReturnType<typeof kpiValues>>) => number | null): Kpi => ({
    value: cur ? pick(cur) : null,
    cmp: cur2 ? pick(cur2) : null,
    prev: prev ? pick(prev) : null,
    spark: spark(pick),
  });

  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const d of rangeDays) {
    const w = weekdayOf(d);
    HOUR_METRICS.forEach((m, h) => {
      heatmap[w][h] += metricOf(store, d, key, m);
    });
  }
  const hubRows = (q.hub === "all" ? HUBS.map((h) => h.id) : [q.hub]).map((h) => {
    const sum = (m: string) => rangeDays.reduce((s, d) => s + metricOf(store, d, h, m), 0);
    const counted = rangeDays.filter((d) => sources.get(d) !== "missing").length;
    return {
      hub: h,
      users: counted > 0 ? sum("users") / counted : 0,
      sessions: sum("sessions"),
      decided: sum("decided"),
      draws: sum("draw_manual") + sum("redraw"),
      shares: sum("share"),
    };
  });

  return {
    ...base(q, deps.now, state.rollupThrough, sources, rangeDays, cmp),
    tab: "overview",
    kpis: {
      users: kpi((v) => v.users),
      newUsers: kpi((v) => v.newUsers),
      sessions: kpi((v) => v.sessions),
      decisionRate: kpi((v) => v.decisionRate),
      drawsPerSession: kpi((v) => v.drawsPerSession),
      shareOpens: kpi((v) => v.shareOpens),
    },
    daily: rangeDays.map((d) => ({
      day: d,
      source: sources.get(d)!,
      manual: metricOf(store, d, key, "draw_manual") + metricOf(store, d, key, "redraw"),
      auto: metricOf(store, d, key, "draw_auto"),
      users: metricOf(store, d, key, "users"),
      sessions: metricOf(store, d, key, "sessions"),
      decided: metricOf(store, d, key, "decided"),
    })),
    heatmap,
    hubs: hubRows,
    alerts: alertsOf(state.ops, hubs.hubs, deps.now, { through: state.rollupThrough, yesterday: addDays(today, -1) }, hubName),
  };
}

const PLACE_KINDS = { picked: "pick:", shared: "share:", excluded: "excl:" } as const;
const isAggregate = (m: string) => m.startsWith("cohort_") || Object.values(PLACE_KINDS).some((p) => m.startsWith(p));
/** Top 10을 고를 때 집계에서 가져오는 후보 수 (실시간 날 횟수를 더해 순위가 바뀔 여유) */
const PLACE_CANDIDATES = 30;

/** 집계한 날들의 지표 합 — SQL이 지표마다 한 행으로 합친다 (가게·코호트 행 제외) */
const TOTALS_SQL = `SELECT metric, sum(value) AS value FROM daily_stats
  WHERE day IN (SELECT value FROM json_each(?1)) AND hub = ?2
    AND metric NOT LIKE 'pick:%' AND metric NOT LIKE 'share:%' AND metric NOT LIKE 'excl:%' AND substr(metric, 1, 7) <> 'cohort_'
  GROUP BY metric`;
/** 집계한 날들의 가게 횟수 상위 — 접두어 범위(pick: ~ pick;)로 PK를 콕 집어 읽고 SQL이 합쳐 순위를 매긴다 */
const PLACES_TOP_SQL = `SELECT metric, sum(value) AS value FROM daily_stats
  WHERE day IN (SELECT value FROM json_each(?1)) AND hub = ?2 AND metric >= ?3 AND metric < ?4
  GROUP BY metric ORDER BY value DESC, metric LIMIT ${PLACE_CANDIDATES}`;
const nextPrefix = (p: string) => p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1);

type Agg = { metric: string; value: number };
function addInto(out: Metrics, rows: Agg[], keep: (m: string) => boolean = () => true) {
  for (const r of rows) if (keep(r.metric)) out[r.metric] = (out[r.metric] ?? 0) + Number(r.value);
}

/**
 * R58 행태 탭. 90일이어도 일별 행을 Worker로 가져오지 않는다: 집계한 날은 SQL이 지표마다 합치고(TOTALS_SQL), 가게는 종류마다
 * 상위 30곳만(PLACES_TOP_SQL), 아직 집계하지 않은 최근 날(실시간, 최대 2일)만 JS에서 더한다.
 */
async function behavior(deps: DashboardDeps, q: DashboardQuery, state: MetaState): Promise<BehaviorData> {
  const today = kstDay(deps.now);
  const liveAllowed = liveAllowedBy(state, deps);
  const rangeDays = dayList(q.from, q.to);
  const cmp = compareDays(q, today, rangeDays);
  const weeks: string[] = [];
  for (let w = mondayOf(q.from); w <= q.to; w = addDays(w, 7)) weeks.push(w);
  const key = hubKey(q.hub);
  const sources = sourcesFor([...rangeDays, ...cmp.prev], today, state.rollupThrough, liveAllowed);
  const rolled = (days: string[]) => days.filter((d) => sources.get(d) === "rollup");
  const live = (days: string[]) => days.filter((d) => sources.get(d) === "live");
  const json = (days: string[]) => JSON.stringify(days);

  const stmts: D1PreparedStatement[] = [deps.db.prepare(TOTALS_SQL).bind(json(rolled(rangeDays)), key)];
  for (const prefix of Object.values(PLACE_KINDS)) {
    stmts.push(deps.db.prepare(PLACES_TOP_SQL).bind(json(rolled(rangeDays)), key, prefix, nextPrefix(prefix)));
  }
  if (cmp.prev.length > 0) stmts.push(deps.db.prepare(TOTALS_SQL).bind(json(rolled(cmp.prev)), key));
  // 코호트 행은 Cron 집계에만 있다 (주 월요일 날짜) — 월요일은 언제나 rollup 질의로 읽는다
  const weekSources = new Map(weeks.map((w) => [w, "rollup" as DaySource]));
  const liveDays = [...new Set([...live(rangeDays), ...live(cmp.prev)])];
  const [rs, cohortStore, lives] = await Promise.all([
    deps.db.batch<Agg>(stmts),
    collect(deps, weekSources, [{ days: weeks, hubs: [key], metrics: COHORT_METRICS }], null),
    Promise.all(
      liveDays.map(async (d) => [d, (await Promise.all((["core", "detail"] as const).map((p) => liveRows(deps, d, p)))).flat()] as const),
    ),
  ]);
  const liveOf = new Map(lives.map(([d, rows]) => [d, rows.filter((r) => r.hub === key)]));
  const liveSum = (days: string[], keep: (m: string) => boolean) => {
    const out: Metrics = {};
    for (const d of days) addInto(out, liveOf.get(d) ?? [], keep);
    return out;
  };
  const plain = (m: string) => !isAggregate(m);
  const merge = (a: Metrics, b: Metrics) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
    return out;
  };

  const rolledTotals: Metrics = {};
  addInto(rolledTotals, rs[0].results);
  const totals = merge(rolledTotals, liveSum(live(rangeDays), plain));
  // 비교용 현재 값: 오늘(끝나지 않은 날)을 뺀 같은 날들 — 집계한 날은 언제나 오늘이 아니다
  const cmpTotals = q.compare ? merge(rolledTotals, liveSum(live(cmp.cur), plain)) : null;
  let prevTotals: Metrics | null = null;
  if (cmp.prev.length > 0) {
    prevTotals = {};
    addInto(prevTotals, rs[4].results);
    prevTotals = merge(prevTotals, liveSum(live(cmp.prev), plain));
  }

  const places = {} as Record<keyof typeof PLACE_KINDS, TopPlace[]>;
  const ids = new Set<string>();
  (Object.entries(PLACE_KINDS) as [keyof typeof PLACE_KINDS, string][]).forEach(([kind, prefix], i) => {
    const counts = new Map<string, number>();
    for (const r of rs[1 + i].results) counts.set(r.metric.slice(prefix.length), Number(r.value));
    for (const d of live(rangeDays)) {
      for (const r of liveOf.get(d) ?? []) {
        if (r.metric.startsWith(prefix)) counts.set(r.metric.slice(prefix.length), (counts.get(r.metric.slice(prefix.length)) ?? 0) + r.value);
      }
    }
    places[kind] = [...counts]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, TOP_PLACES_SHOWN)
      .map(([placeId, count]) => ({ placeId, name: null, count }));
    for (const p of places[kind]) ids.add(p.placeId);
  });
  if (ids.size > 0) {
    const r = await deps.db
      .prepare("SELECT id, name FROM places WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify([...ids]))
      .all<{ id: string; name: string | null }>();
    const names = new Map(r.results.map((x) => [x.id, x.name]));
    for (const list of Object.values(places)) for (const p of list) p.name = names.get(p.placeId) ?? null;
  }

  const through = state.rollupThrough;
  const cohorts: Cohort[] = weeks
    .map((w) => ({
      week: w,
      size: metricOf(cohortStore, w, key, "cohort_size"),
      // 주 첫날 + n일이 지났으면 값(일부만 관찰), 주 마지막 날 + n일까지 지났으면 다 관찰
      ret: RETENTION_DAYS.map((n) =>
        through !== null && addDays(w, n) <= through ? metricOf(cohortStore, w, key, `cohort_d${n}`) : null,
      ),
      partial: RETENTION_DAYS.map((n) => through !== null && addDays(w, n) <= through && addDays(w, 6 + n) > through),
    }))
    .filter((c) => c.size > 0);

  return {
    ...base(q, deps.now, through, sources, rangeDays, cmp),
    tab: "behavior",
    totals,
    cmpTotals,
    prevTotals,
    cohorts,
    places,
    collectSince: state.collectSince,
  };
}

async function ops(deps: DashboardDeps, q: DashboardQuery, state: MetaState): Promise<OpsData> {
  const today = kstDay(deps.now);
  const liveAllowed = liveAllowedBy(state, deps);
  const [hubs, count] = await Promise.all([
    cachedHubStatuses(deps, liveAllowed),
    // 오늘 이벤트 수는 idx_events_day 색인만 센다 (실시간 집계보다 훨씬 싸다)
    liveAllowed
      ? deps.db.prepare("SELECT count(*) AS n FROM events WHERE day = ?").bind(today).first<{ n: number }>()
      : Promise.resolve(null),
  ]);
  const rangeDays = dayList(q.from, q.to);
  const sources = sourcesFor(rangeDays, today, state.rollupThrough, liveAllowed);
  return {
    ...base(q, deps.now, state.rollupThrough, sources, rangeDays),
    tab: "ops",
    ops: state.ops,
    hubs: hubs.hubs,
    hubsComputedAt: hubs.at,
    eventsToday: count ? Number(count.n) : null,
    alerts: alertsOf(state.ops, hubs.hubs, deps.now, { through: state.rollupThrough, yesterday: addDays(today, -1) }, hubName),
  };
}

export async function buildDashboard(deps: DashboardDeps, q: DashboardQuery): Promise<OverviewData | BehaviorData | OpsData> {
  const state = await readState(deps);
  if (q.tab === "overview") return overview(deps, q, state);
  if (q.tab === "behavior") return behavior(deps, q, state);
  return ops(deps, q, state);
}
