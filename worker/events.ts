import { EVENT_RETENTION_DAYS, type DayStats, type StatsResponse, type StoredEvent } from "../shared/events";
import { DAY_MS, kstDay, kstDayHour } from "../shared/kst";
import { d1UsageOn, pruneD1Usage } from "./d1Usage";

/** R35: 한 요청의 이벤트를 db.batch 한 번으로 넣는다 */
export async function insertEvents(db: D1Database, anon: string, session: string, events: StoredEvent[]): Promise<void> {
  if (events.length === 0) return;
  const stmt = db.prepare(
    "INSERT INTO events (ts, day, hour, anon, session, hub, type, place_id, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  await db.batch(events.map((e) => stmt.bind(e.ts, e.day, e.hour, anon, session, e.hub, e.type, e.placeId, e.props)));
}

/** Cron은 5분마다 돈다 — KST 04:00~04:04에 걸리는 한 번만 정리한다 */
export function isRetentionWindow(now: number): boolean {
  return kstDayHour(now).hour === 4 && new Date(now).getUTCMinutes() < 5;
}

/**
 * R35: 90일 지난 날의 이벤트를 지운다. ts 대신 day로 지워서 idx_events_day 범위만 읽는다(전체 스캔 없음).
 * 날짜별 D1 사용량 기록(R38)도 같은 기준으로 지운다.
 */
export async function pruneOldEvents(db: D1Database, now: number): Promise<void> {
  const cutoff = kstDay(now - EVENT_RETENTION_DAYS * DAY_MS);
  await db.prepare("DELETE FROM events WHERE day < ?").bind(cutoff).run();
  await pruneD1Usage(db, cutoff);
}

const DRAWS = "('draw', 'redraw')";
/** 일별·거점별 행동 수 집계에 쓰는 타입 (filter_change 같은 잦은 이벤트는 읽지 않는다) */
const ACTION_TYPES = "('draw', 'redraw', 'share', 'open_kakao', 'share_open', 'expand_card', 'exclude_place')";

const emptyDay = (day: string): DayStats => ({
  day, users: 0, sessions: 0, draws: 0, redraws: 0, shares: 0, openKakao: 0, shareOpens: 0,
});
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/**
 * R36: 관리자 통계. 범위 [from, to]의 이벤트를 (type, day) 인덱스로 타입별로 좁혀 읽는다.
 * 쿼리 5개 + 이름 1개: app_open(사용자·세션), 행동 수, 시간대, 상위 가게(picks), 세션 전환.
 */
export async function eventStats(
  db: D1Database, opts: { days: number; hub: string; now: number; readSoftCap: number },
): Promise<StatsResponse> {
  const to = kstDay(opts.now);
  const from = kstDay(opts.now - (opts.days - 1) * DAY_MS);
  const inRange = (t = "") => `${t}day BETWEEN ? AND ?${opts.hub === "all" ? "" : ` AND ${t}hub = ?`}`;
  const args = () => (opts.hub === "all" ? [from, to] : [from, to, opts.hub]);
  const range = inRange();

  const [opens, actions, hours, picks, conv, today] = await Promise.all([
    // 세션마다 app_open이 하나라서 세션 수 = app_open 수. (날짜, 거점, 사용자)로 묶어 돌려받아 메모리에서 센다
    db
      .prepare(`SELECT day, hub, anon, count(*) AS n FROM events WHERE type = 'app_open' AND ${range} GROUP BY day, hub, anon`)
      .bind(...args())
      .all<{ day: string; hub: string; anon: string; n: number }>(),
    db
      .prepare(
        `SELECT day, hub, type, json_extract(props, '$.rank') AS rank, count(*) AS n FROM events
         WHERE type IN ${ACTION_TYPES} AND ${range} GROUP BY day, hub, type, rank`,
      )
      .bind(...args())
      .all<{ day: string; hub: string; type: string; rank: number | null; n: number }>(),
    db
      .prepare(`SELECT hour, count(*) AS n FROM events WHERE type IN ${DRAWS} AND ${range} GROUP BY hour`)
      .bind(...args())
      .all<{ hour: number; n: number }>(),
    db
      .prepare(
        // json_each에도 type 열이 있어서 events 열은 e.로 적는다
        `SELECT j.value AS id, count(*) AS n FROM events AS e, json_each(e.props, '$.picks') AS j
         WHERE e.type IN ${DRAWS} AND ${inRange("e.")} GROUP BY j.value ORDER BY n DESC, j.value LIMIT 10`,
      )
      .bind(...args())
      .all<{ id: string; n: number }>(),
    db
      .prepare(
        `SELECT coalesce(sum(d), 0) AS drawSessions, coalesce(sum(d * s), 0) AS shareSessions, coalesce(sum(d * k), 0) AS kakaoSessions
         FROM (SELECT max(type IN ${DRAWS}) AS d, max(type = 'share') AS s, max(type = 'open_kakao') AS k
               FROM events WHERE type IN ('draw', 'redraw', 'share', 'open_kakao') AND ${range} GROUP BY session)`,
      )
      .bind(...args())
      .first<{ drawSessions: number; shareSessions: number; kakaoSessions: number }>(),
    d1UsageOn(db, to),
  ]);

  const days: string[] = [];
  for (let i = opts.days - 1; i >= 0; i--) days.push(kstDay(opts.now - i * DAY_MS));
  const daily = new Map(days.map((d) => [d, emptyDay(d)]));
  const dayUsers = new Map<string, Set<string>>();
  const allUsers = new Set<string>();
  type HubRow = StatsResponse["hubs"][number];
  const hubs = new Map<string, HubRow & { anons: Set<string> }>();
  const hubOf = (hub: string) => {
    let h = hubs.get(hub);
    if (!h) hubs.set(hub, (h = { hub, users: 0, sessions: 0, draws: 0, shares: 0, anons: new Set() }));
    return h;
  };

  for (const o of opens.results) {
    const d = daily.get(o.day);
    if (!d) continue;
    d.sessions += o.n;
    let set = dayUsers.get(o.day);
    if (!set) dayUsers.set(o.day, (set = new Set()));
    set.add(o.anon);
    allUsers.add(o.anon);
    const h = hubOf(o.hub);
    h.sessions += o.n;
    h.anons.add(o.anon);
  }
  for (const [day, set] of dayUsers) daily.get(day)!.users = set.size;

  const ranks = { expand: [0, 0, 0], kakao: [0, 0, 0], exclude: [0, 0, 0] };
  let expands = 0;
  let excludes = 0;
  for (const a of actions.results) {
    const d = daily.get(a.day);
    if (!d) continue;
    const slot = typeof a.rank === "number" && a.rank >= 1 && a.rank <= 3 ? a.rank - 1 : null;
    switch (a.type) {
      case "draw":
        d.draws += a.n;
        hubOf(a.hub).draws += a.n;
        break;
      case "redraw":
        d.redraws += a.n;
        hubOf(a.hub).draws += a.n;
        break;
      case "share":
        d.shares += a.n;
        hubOf(a.hub).shares += a.n;
        break;
      case "open_kakao":
        d.openKakao += a.n;
        if (slot !== null) ranks.kakao[slot] += a.n;
        break;
      case "share_open":
        d.shareOpens += a.n;
        break;
      case "expand_card":
        expands += a.n;
        if (slot !== null) ranks.expand[slot] += a.n;
        break;
      case "exclude_place":
        excludes += a.n;
        if (slot !== null) ranks.exclude[slot] += a.n;
        break;
    }
  }

  const dailyList = days.map((d) => daily.get(d)!);
  const sum = (k: keyof Omit<DayStats, "day" | "users">) => dailyList.reduce((s, d) => s + d[k], 0);
  const totals = {
    users: allUsers.size,
    sessions: sum("sessions"),
    draws: sum("draws"),
    redraws: sum("redraws"),
    shares: sum("shares"),
    openKakao: sum("openKakao"),
    shareOpens: sum("shareOpens"),
    expands,
    excludes,
  };

  const hourly = Array.from({ length: 24 }, () => 0);
  for (const h of hours.results) if (h.hour >= 0 && h.hour < 24) hourly[h.hour] += h.n;

  const ids = picks.results.map((p) => String(p.id));
  const names = new Map<string, string | null>();
  if (ids.length > 0) {
    const r = await db
      .prepare(`SELECT id, name FROM places WHERE id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<{ id: string; name: string | null }>();
    for (const x of r.results) names.set(x.id, x.name);
  }

  const drawSessions = conv?.drawSessions ?? 0;
  return {
    range: { from, to, days: opts.days, hub: opts.hub },
    daily: dailyList,
    totals,
    hourly,
    hubs: [...hubs.values()]
      .map(({ anons, ...h }) => ({ ...h, users: anons.size }))
      .sort((a, b) => b.sessions - a.sessions || (a.hub < b.hub ? -1 : a.hub > b.hub ? 1 : 0)),
    top: picks.results.map((p) => ({ placeId: String(p.id), name: names.get(String(p.id)) ?? null, count: p.n })),
    ranks,
    conversion: {
      drawSessions,
      toShare: ratio(conv?.shareSessions ?? 0, drawSessions),
      toKakao: ratio(conv?.kakaoSessions ?? 0, drawSessions),
    },
    drawsPerSession: ratio(totals.draws + totals.redraws, totals.sessions),
    d1Today: { ...today, readSoftCap: opts.readSoftCap },
  };
}
