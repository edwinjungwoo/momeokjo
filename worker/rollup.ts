import {
  COHORT_METRICS, DAILY_STATS_RETENTION_DAYS, ROLLUP_DAYS_PER_RUN, ROLLUP_HOUR_KST, TOP_PLACES_PER_DAY, addDays, dayList, mondayOf,
} from "../shared/dashboard";
import { EVENT_RETENTION_DAYS } from "../shared/events";
import { DAY_MS, kstDay, kstDayHour } from "../shared/kst";

/**
 * R54 일별 집계. 하루치 지표를 SQL 집계 문장 4개로 계산한다 — Cron은 같은 문장을 INSERT … SELECT로 감싸 daily_stats에 쓰고
 * (D1 batch 한 번, Worker CPU는 거의 쓰지 않는다), 관리자 화면은 아직 집계하지 않은 날(오늘)만 같은 SELECT로 센다.
 * 모든 문장은 ?1 = KST 날짜 하나만 받고, (hub, metric, value) 행을 돌려준다. hub = 거점 id 또는 '*'(모든 거점). 값이 0인 행은 없다.
 * 지표 정의는 shared/dashboard.ts METRICS·METRIC_FAMILIES와 스펙 R53.
 * 주의: D1은 UNION ALL 한 덩어리에 SELECT를 5개까지만 받는다("too many terms in compound SELECT") — 열을 행으로 펼 때는
 * VALUES 목록 × CASE, 이벤트 하나에서 여러 행을 낼 때는 json_each(json_array(...))를 쓴다.
 */
export type MetricRow = { hub: string; metric: string; value: number };

const AUTO = "coalesce(json_extract(props, '$.auto'), 0) = 1";

/** 세션 단위 지표: 사용자·세션·결정·퍼널·다시 뽑기 분포·결정까지 걸린 시간·자동 뽑기 수용·공유 링크·시간대별 세션 */
const SESSION_COLUMNS: [string, string][] = [
  ["users", "count(DISTINCT CASE WHEN opened THEN anon END)"],
  [
    "new_users",
    "count(DISTINCT CASE WHEN opened AND NOT EXISTS (SELECT 1 FROM anon_first_seen f WHERE f.anon = gs.anon AND f.day < ?1) THEN anon END)",
  ],
  ["sessions", "count(CASE WHEN opened THEN 1 END)"],
  ["decided", "count(CASE WHEN opened AND first_decision IS NOT NULL THEN 1 END)"],
  ["funnel_draw", "count(CASE WHEN opened AND drew THEN 1 END)"],
  ["funnel_draw_manual", "count(CASE WHEN opened AND drew AND manual > 0 THEN 1 END)"],
  ["funnel_draw_auto_only", "count(CASE WHEN opened AND drew AND manual = 0 THEN 1 END)"],
  ["funnel_expand", "count(CASE WHEN opened AND drew AND expanded THEN 1 END)"],
  ["funnel_decide", "count(CASE WHEN opened AND drew AND expanded AND first_decision IS NOT NULL THEN 1 END)"],
  ["funnel_share", "count(CASE WHEN opened AND drew AND expanded AND shared THEN 1 END)"],
  ["funnel_kakao", "count(CASE WHEN opened AND drew AND expanded AND kakao THEN 1 END)"],
  ["funnel_confirm", "count(CASE WHEN opened AND drew AND expanded AND confirmed THEN 1 END)"],
  ["redraws_0", "count(CASE WHEN drew AND redraws = 0 THEN 1 END)"],
  ["redraws_1", "count(CASE WHEN drew AND redraws = 1 THEN 1 END)"],
  ["redraws_2", "count(CASE WHEN drew AND redraws = 2 THEN 1 END)"],
  ["redraws_3p", "count(CASE WHEN drew AND redraws >= 3 THEN 1 END)"],
  ...(
    [
      ["dt_lt10", 0, 10],
      ["dt_lt30", 10, 30],
      ["dt_lt60", 30, 60],
      ["dt_lt120", 60, 120],
      ["dt_lt300", 120, 300],
      ["dt_lt900", 300, 900],
      ["dt_ge900", 900, null],
    ] as const
  ).map(
    ([name, lo, hi]): [string, string] => [
      name,
      `count(CASE WHEN first_decision >= first_draw AND first_decision - first_draw >= ${lo * 1000}${hi === null ? "" : ` AND first_decision - first_draw < ${hi * 1000}`} THEN 1 END)`,
    ],
  ),
  ["auto_sessions", "count(CASE WHEN autos > 0 THEN 1 END)"],
  ["auto_accepted", "count(CASE WHEN autos > 0 AND accepted THEN 1 END)"],
  ["auto_redrawn", "count(CASE WHEN autos > 0 AND NOT accepted AND first_manual > first_auto THEN 1 END)"],
  ["auto_left", "count(CASE WHEN autos > 0 AND NOT accepted AND NOT coalesce(first_manual > first_auto, 0) THEN 1 END)"],
  ["link_sessions", "count(CASE WHEN via_link THEN 1 END)"],
  ["reshare_sessions", "count(CASE WHEN via_link AND shared THEN 1 END)"],
];

const SESSIONS_SQL = `WITH ev AS NOT MATERIALIZED (
  SELECT session, anon, hub, hour, type, ts,
    CASE WHEN type IN ('draw', 'redraw') THEN ${AUTO} END AS auto,
    CASE WHEN type = 'share' THEN coalesce(json_extract(props, '$.confirm'), 0) = 1 END AS confirm
  FROM events WHERE day = ?1 AND type IN ('app_open', 'draw', 'redraw', 'share', 'open_kakao', 'expand_card', 'share_open')
),
s AS MATERIALIZED (
  SELECT session, max(anon) AS anon,
    coalesce(max(CASE WHEN type = 'app_open' THEN hub END), max(hub)) AS hub,
    max(type = 'app_open') AS opened,
    min(CASE WHEN type = 'app_open' THEN hour END) AS open_hour,
    max(type IN ('draw', 'redraw')) AS drew,
    count(CASE WHEN auto = 0 THEN 1 END) AS manual,
    count(CASE WHEN auto = 1 THEN 1 END) AS autos,
    count(CASE WHEN type = 'redraw' AND auto = 0 THEN 1 END) AS redraws,
    max(type = 'expand_card') AS expanded,
    max(type = 'share') AS shared,
    max(coalesce(confirm, 0)) AS confirmed,
    max(type = 'open_kakao') AS kakao,
    max(type = 'share_open') AS via_link,
    min(CASE WHEN type IN ('draw', 'redraw') THEN ts END) AS first_draw,
    min(CASE WHEN auto = 1 THEN ts END) AS first_auto,
    min(CASE WHEN auto = 0 THEN ts END) AS first_manual,
    min(CASE WHEN type IN ('share', 'open_kakao') THEN ts END) AS first_decision
  FROM ev GROUP BY session
),
gs AS (
  SELECT hub AS grp, *, coalesce(first_decision >= first_auto AND (first_manual IS NULL OR first_manual > first_decision), 0) AS accepted FROM s
  UNION ALL
  SELECT '*' AS grp, *, coalesce(first_decision >= first_auto AND (first_manual IS NULL OR first_manual > first_decision), 0) FROM s
),
w AS MATERIALIZED (
  SELECT grp, ${SESSION_COLUMNS.map(([name, expr]) => `${expr} AS ${name}`).join(",\n    ")}
  FROM gs GROUP BY grp
)
SELECT hub, metric, value FROM (
  SELECT w.grp AS hub, m.column1 AS metric,
    CASE m.column1 ${SESSION_COLUMNS.map(([name]) => `WHEN '${name}' THEN w.${name}`).join(" ")} END AS value
  FROM w, (VALUES ${SESSION_COLUMNS.map(([name]) => `('${name}')`).join(", ")}) AS m
  UNION ALL SELECT grp, 'sessions_h' || printf('%02d', open_hour), count(*) FROM gs WHERE opened AND open_hour IS NOT NULL GROUP BY grp, open_hour
) WHERE value > 0`;

/** 이벤트 수: 종류별(자동·직접 뽑기, 확정 공유 구분), 결과 카드 번호별, 완화 섞인 뽑기, 모든 이벤트 */
const EVENTS_SQL = `WITH x AS MATERIALIZED (
  SELECT hub,
    CASE
      WHEN type IN ('draw', 'redraw') AND ${AUTO} THEN 'draw_auto'
      WHEN type = 'draw' THEN 'draw_manual'
      WHEN type = 'share' AND coalesce(json_extract(props, '$.confirm'), 0) = 1 THEN 'share_confirm'
      WHEN type = 'expand_card' THEN 'expand'
      WHEN type = 'exclude_place' THEN 'exclude'
      ELSE type
    END AS kind,
    json_extract(props, '$.rank') AS rank,
    coalesce(json_extract(props, '$.relaxed'), 0) AS relaxed,
    count(*) AS n
  FROM events WHERE day = ?1 GROUP BY 1, 2, 3, 4
),
y AS (
  SELECT hub, kind AS metric, n FROM x WHERE kind <> 'app_open'
  UNION ALL SELECT hub, 'share', n FROM x WHERE kind = 'share_confirm'
  UNION ALL SELECT hub, 'draw_relaxed', n FROM x WHERE relaxed = 1 AND kind IN ('draw_auto', 'draw_manual', 'redraw')
  UNION ALL SELECT hub, 'events', n FROM x
  UNION ALL SELECT hub,
    CASE kind WHEN 'expand' THEN 'expand_r' WHEN 'open_kakao' THEN 'kakao_r' WHEN 'exclude' THEN 'exclude_r' ELSE 'confirm_r' END || rank, n
    FROM x WHERE kind IN ('expand', 'open_kakao', 'exclude', 'share_confirm') AND rank IN (1, 2, 3)
)
SELECT hub, metric, sum(n) AS value FROM y GROUP BY hub, metric
UNION ALL SELECT '*', metric, sum(n) FROM y GROUP BY metric`;

/** 필터 분포: filter_change 스냅숏(바뀐 뒤의 필터)마다 값 하나씩 센다 */
const FILTERS_SQL = `WITH f AS MATERIALIZED (
  SELECT hub, props, count(*) AS n FROM events WHERE type = 'filter_change' AND day = ?1 GROUP BY hub, props
),
y AS MATERIALIZED (
  SELECT f.hub AS hub, j.value AS metric, sum(f.n) AS n FROM f, json_each(json_array(
    'f_total',
    'f_party_' || json_extract(props, '$.party'),
    'f_price_' || json_extract(props, '$.priceCap'),
    'f_rating_' || json_extract(props, '$.minRating'),
    'f_open_' || json_extract(props, '$.openOnly'),
    'f_radius_' || CASE WHEN json_extract(props, '$.radius') IS NULL THEN NULL WHEN json_extract(props, '$.radius') <= 300 THEN 300
      WHEN json_extract(props, '$.radius') <= 500 THEN 500 WHEN json_extract(props, '$.radius') <= 700 THEN 700 ELSE 1000 END,
    CASE WHEN json_type(props, '$.groups') = 'array' AND json_array_length(props, '$.groups') = 0 THEN 'f_group_all' END
  )) AS j WHERE j.value IS NOT NULL GROUP BY 1, 2
  UNION ALL SELECT f.hub, 'f_group_' || g.value, sum(f.n) FROM f, json_each(f.props, '$.groups') AS g GROUP BY 1, 2
)
SELECT hub, metric, n AS value FROM y
UNION ALL SELECT '*', metric, sum(n) FROM y GROUP BY metric`;

/** 가게별 횟수: 직접 뽑기 picks, 공유 picks, "여긴 빼줘" — 거점·종류마다 그날 상위 TOP_PLACES_PER_DAY곳만 */
const PLACES_SQL = `WITH p AS MATERIALIZED (
  SELECT e.hub AS hub, 'pick' AS k, j.value AS id, count(*) AS n FROM events AS e, json_each(e.props, '$.picks') AS j
    WHERE e.type IN ('draw', 'redraw') AND e.day = ?1 AND coalesce(json_extract(e.props, '$.auto'), 0) = 0 GROUP BY 1, 3
  UNION ALL SELECT e.hub, 'share', j.value, count(*) FROM events AS e, json_each(e.props, '$.picks') AS j
    WHERE e.type = 'share' AND e.day = ?1 GROUP BY 1, 3
  UNION ALL SELECT hub, 'excl', place_id, count(*) FROM events WHERE type = 'exclude_place' AND day = ?1 AND place_id IS NOT NULL
    GROUP BY 1, 3
),
c AS (SELECT hub, k, id, n FROM p UNION ALL SELECT '*', k, id, sum(n) FROM p GROUP BY k, id),
r AS (SELECT hub, k, id, n, row_number() OVER (PARTITION BY hub, k ORDER BY n DESC, id) AS rn FROM c)
SELECT hub, k || ':' || id AS metric, n AS value FROM r WHERE rn <= ${TOP_PLACES_PER_DAY}`;

/** 하루 지표를 계산하는 문장들 (실시간 집계와 Cron 집계가 같은 것을 쓴다) */
export const DAY_METRIC_SQL = [SESSIONS_SQL, EVENTS_SQL, FILTERS_SQL, PLACES_SQL] as const;

/**
 * 실시간 집계를 나눠 세는 단위: core = 세션·이벤트 수(개요·행태), detail = 필터·가게(행태만).
 * 읽기는 그날 이벤트 수에 비례한다 (로컬 측정: core ≈ 이벤트 × 5.7행, detail ≈ × 7.3행 — json_each·정렬도 읽기로 센다)
 */
export type LivePart = "core" | "detail" | "all";
const PART_SQL: Record<LivePart, readonly string[]> = {
  core: [SESSIONS_SQL, EVENTS_SQL],
  detail: [FILTERS_SQL, PLACES_SQL],
  all: DAY_METRIC_SQL,
};

/** 아직 집계하지 않은 날(오늘)의 지표를 센다 — D1 batch 한 번 */
export async function liveDayMetrics(db: D1Database, day: string, part: LivePart = "all"): Promise<MetricRow[]> {
  const rs = await db.batch<MetricRow>(PART_SQL[part].map((sql) => db.prepare(sql).bind(day)));
  return rs.flatMap((r) => r.results.map((x) => ({ hub: String(x.hub), metric: String(x.metric), value: Number(x.value) })));
}

/** 첫 방문·재방문 비트·마지막 방문일 갱신. 그날 처음 온 id는 넣고, 전에 온 id는 (첫 방문일 + n일 이후) 비트를 켠다. 바뀌는 행만 쓴다 */
export const FIRST_SEEN_UPSERT = `INSERT INTO anon_first_seen (anon, day, hub, ret, last_day)
SELECT anon, ?1, hub, 0, ?1 FROM (SELECT anon, hub, min(ts) FROM events WHERE type = 'app_open' AND day = ?1 GROUP BY anon) WHERE true
ON CONFLICT(anon) DO UPDATE SET
  ret = CASE WHEN excluded.day > anon_first_seen.day THEN anon_first_seen.ret | (
    CASE WHEN julianday(excluded.day) - julianday(anon_first_seen.day) >= 28 THEN 15
         WHEN julianday(excluded.day) - julianday(anon_first_seen.day) >= 14 THEN 7
         WHEN julianday(excluded.day) - julianday(anon_first_seen.day) >= 7 THEN 3
         ELSE 1 END) ELSE anon_first_seen.ret END,
  hub = CASE WHEN excluded.day < anon_first_seen.day THEN excluded.hub ELSE anon_first_seen.hub END,
  day = min(anon_first_seen.day, excluded.day),
  last_day = max(anon_first_seen.last_day, excluded.last_day)
WHERE excluded.day < anon_first_seen.day OR excluded.last_day > anon_first_seen.last_day`;

/** 코호트 행을 다시 쓴다: ?1 = 첫 방문일 하한(월요일), ?2 = 다시 쓸 주(월요일) JSON 목록 */
const COHORT_DELETE = `DELETE FROM daily_stats WHERE day IN (SELECT value FROM json_each(?2))
  AND metric IN (${COHORT_METRICS.map((m) => `'${m}'`).join(", ")}) AND ?1 IS NOT NULL`;
const COHORT_INSERT = `INSERT INTO daily_stats (day, hub, metric, value)
SELECT wk, grp, metric, value FROM (
  WITH c AS MATERIALIZED (
    SELECT date(day, '-' || ((CAST(strftime('%w', day) AS INTEGER) + 6) % 7) || ' days') AS wk, hub, ret
    FROM anon_first_seen WHERE day >= ?1
  ),
  g AS (SELECT wk, hub AS grp, ret FROM c UNION ALL SELECT wk, '*', ret FROM c),
  a AS (
    SELECT wk, grp, count(*) AS size, count(CASE WHEN ret & 1 THEN 1 END) AS d1, count(CASE WHEN ret & 2 THEN 1 END) AS d7,
      count(CASE WHEN ret & 4 THEN 1 END) AS d14, count(CASE WHEN ret & 8 THEN 1 END) AS d28
    FROM g GROUP BY wk, grp
  )
  SELECT wk, grp, 'cohort_size' AS metric, size AS value FROM a
  UNION ALL SELECT wk, grp, 'cohort_d1', d1 FROM a
  UNION ALL SELECT wk, grp, 'cohort_d7', d7 FROM a
  UNION ALL SELECT wk, grp, 'cohort_d14', d14 FROM a
  UNION ALL SELECT wk, grp, 'cohort_d28', d28 FROM a
) WHERE value > 0 AND ?2 IS NOT NULL`;

const META_UPSERT = "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
export const ROLLUP_THROUGH_KEY = "rollup_through";

/** 하루를 집계해 쓰는 문장들 (batch 하나 — 중간에 실패하면 그날 전체가 되돌아가고 커서도 그대로다) */
export function rollupDayStatements(db: D1Database, day: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM daily_stats WHERE day = ?1 AND metric NOT LIKE 'cohort\\_%' ESCAPE '\\'").bind(day),
    db.prepare(FIRST_SEEN_UPSERT).bind(day),
    ...DAY_METRIC_SQL.map((sql) => db.prepare(`INSERT INTO daily_stats (day, hub, metric, value) SELECT ?1, hub, metric, value FROM (${sql})`).bind(day)),
    db.prepare(META_UPSERT).bind(ROLLUP_THROUGH_KEY, day),
  ];
}

/** 코호트(첫 방문 주)를 다시 센다: 첫 방문이 today − 90일이 속한 주의 월요일 이후인 id만 */
export function cohortStatements(db: D1Database, today: string): D1PreparedStatement[] {
  const since = mondayOf(addDays(today, -EVENT_RETENTION_DAYS));
  const weeks: string[] = [];
  for (let w = since; w <= today; w = addDays(w, 7)) weeks.push(w);
  const list = JSON.stringify(weeks);
  return [db.prepare(COHORT_DELETE).bind(since, list), db.prepare(COHORT_INSERT).bind(since, list)];
}

/** 집계를 마친 마지막 날 (없으면 null) */
export async function rollupThrough(db: D1Database): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(ROLLUP_THROUGH_KEY).first<{ value: string }>();
  return r?.value ?? null;
}

/** 지금 집계해도 되는 마지막 날: KST 04시가 지났으면 어제, 아니면 그저께 */
export function lastRollableDay(now: number): string {
  const { day, hour } = kstDayHour(now);
  return addDays(day, hour >= ROLLUP_HOUR_KST ? -1 : -2);
}

/**
 * R54 Cron: 밀린 날을 오래된 날부터 ROLLUP_DAYS_PER_RUN일까지 집계한다 (하루 = batch 한 번). 처음이면 보관 중인 가장 오래된 이벤트 날부터.
 * 다 따라잡았으면 meta 1행만 읽는다. 하루라도 집계했으면 마지막 batch에서 코호트를 다시 센다. 집계한 날 수를 돌려준다.
 */
export async function runRollups(db: D1Database, now: number): Promise<number> {
  const last = lastRollableDay(now);
  const oldest = kstDay(now - EVENT_RETENTION_DAYS * DAY_MS);
  const through = await rollupThrough(db);
  if (through !== null && through >= last) return 0;
  let start = through === null ? null : addDays(through, 1);
  if (start === null) {
    const first = await db.prepare("SELECT min(day) AS d FROM events").first<{ d: string | null }>();
    if (!first?.d) {
      // 이벤트가 하나도 없다 — 집계할 날이 없으니 커서만 둔다
      await db.prepare(META_UPSERT).bind(ROLLUP_THROUGH_KEY, last).run();
      return 0;
    }
    start = first.d;
  }
  if (start < oldest) start = oldest;
  const days = dayList(start, last).slice(0, ROLLUP_DAYS_PER_RUN);
  for (const [i, day] of days.entries()) {
    const stmts = rollupDayStatements(db, day);
    if (i === days.length - 1) stmts.splice(stmts.length - 1, 0, ...cohortStatements(db, kstDay(now)));
    await db.batch(stmts);
  }
  return days.length;
}

/** R35 보관 정리 창에서 같이: 90일 넘게 오지 않은 id의 첫 방문 기록, DAILY_STATS_RETENTION_DAYS 지난 집계를 지운다 */
export async function pruneRollups(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM anon_first_seen WHERE last_day < ?").bind(kstDay(now - EVENT_RETENTION_DAYS * DAY_MS)),
    db.prepare("DELETE FROM daily_stats WHERE day < ?").bind(kstDay(now - DAILY_STATS_RETENTION_DAYS * DAY_MS)),
  ]);
}
