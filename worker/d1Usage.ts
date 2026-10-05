import { utcDay } from "../shared/kst";

/**
 * R38 D1 읽기 예산. 무료 플랜은 하루 읽기 5,000,000행이 넘으면 그날 D1이 멈춘다.
 * 요청·Cron 실행마다 D1 결과의 meta.rows_read/rows_written을 메모리에 모으고, 끝날 때 한 번만 meta에 더한다.
 * 한도는 UTC 자정(KST 09:00)에 초기화되므로 날짜 키도 UTC 날짜다 ("wait until tomorrow (midnight UTC)").
 */
export type D1Usage = { read: number; written: number };

export const DEFAULT_READ_SOFT_CAP = 3_000_000;
/** 하루 쓰기 100,000행 중 이벤트 수집(R35)이 넘지 않게 멈추는 선 */
export const DEFAULT_WRITE_SOFT_CAP = 60_000;
const readKey = (day: string) => `d1_read:${day}`;
const writtenKey = (day: string) => `d1_written:${day}`;

function add(usage: D1Usage, meta: Partial<D1Meta> | undefined) {
  usage.read += Number(meta?.rows_read ?? 0) || 0;
  usage.written += Number(meta?.rows_written ?? 0) || 0;
}

class MeteredStatement {
  constructor(readonly inner: D1PreparedStatement, private readonly usage: D1Usage) {}
  bind(...values: unknown[]) {
    return new MeteredStatement(this.inner.bind(...values), this.usage);
  }
  async all<T>() {
    const r = await this.inner.all<T>();
    add(this.usage, r.meta);
    return r;
  }
  async run<T>() {
    const r = await this.inner.run<T>();
    add(this.usage, r.meta);
    return r;
  }
  /** D1의 first()도 쿼리 전체를 실행하고 첫 행만 돌려준다. meta를 얻으려고 all()로 대신한다 */
  async first<T>(colName?: string): Promise<T | null> {
    const r = await this.inner.all<Record<string, unknown>>();
    add(this.usage, r.meta);
    const row = r.results[0];
    if (!row) return null;
    return (colName === undefined ? row : (row[colName] ?? null)) as T | null;
  }
  raw<T>(options?: { columnNames?: boolean }) {
    return this.inner.raw<T>(options as { columnNames?: false });
  }
}

const unwrap = (s: D1PreparedStatement) =>
  (s as unknown) instanceof MeteredStatement ? (s as unknown as MeteredStatement).inner : s;

/** 쓴 행 수를 usage에 모으는 D1Database (같은 인터페이스) */
export function meteredDb(db: D1Database, usage: D1Usage): D1Database {
  const wrapped = {
    prepare: (query: string) => new MeteredStatement(db.prepare(query), usage) as unknown as D1PreparedStatement,
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const rs = await db.batch<T>(statements.map(unwrap));
      for (const r of rs) add(usage, r.meta);
      return rs;
    },
    exec: (query: string) => db.exec(query),
    withSession: (c?: string) => db.withSession(c),
    dump: () => db.dump(),
  };
  return wrapped as unknown as D1Database;
}

const ADD_UPSERT = `INSERT INTO meta (key, value) VALUES (?, ?), (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + CAST(excluded.value AS INTEGER)`;

/** 오늘(UTC) 사용량에 더한다 — UPSERT 한 문장. 이 기록 자체(몇 행)는 세지 않는다 */
export async function recordD1Usage(db: D1Database, usage: D1Usage, now: number): Promise<void> {
  if (usage.read <= 0 && usage.written <= 0) return;
  const day = utcDay(now);
  await db
    .prepare(ADD_UPSERT)
    .bind(readKey(day), String(Math.round(usage.read)), writtenKey(day), String(Math.round(usage.written)))
    .run();
}

export async function d1UsageOn(db: D1Database, day: string): Promise<D1Usage> {
  const r = await db
    .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
    .bind(readKey(day), writtenKey(day))
    .all<{ key: string; value: string }>();
  const get = (k: string) => {
    const v = Number(r.results.find((x) => x.key === k)?.value ?? 0);
    return Number.isFinite(v) ? v : 0;
  };
  return { read: get(readKey(day)), written: get(writtenKey(day)) };
}

function positiveVar(env: Env, name: string, fallback: number): number {
  const v = Number((env as unknown as Record<string, string | undefined>)[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const readSoftCap = (env: Env) => positiveVar(env, "D1_READ_SOFT_CAP", DEFAULT_READ_SOFT_CAP);
export const writeSoftCap = (env: Env) => positiveVar(env, "D1_WRITE_SOFT_CAP", DEFAULT_WRITE_SOFT_CAP);

/** 오늘 읽기가 소프트 한도 이상이면 true — 이날은 수집·보충(외부 호출과 큰 D1 스캔)을 멈추고 캐시된 데이터만 보여준다 */
export async function overReadBudget(db: D1Database, env: Env, now: number): Promise<boolean> {
  return (await d1UsageOn(db, utcDay(now))).read >= readSoftCap(env);
}

/** 오늘(UTC) 쓰기가 소프트 한도 이상이면 true — 이벤트 수집(R35)을 멈춘다 */
export async function overWriteBudget(db: D1Database, env: Env, now: number): Promise<boolean> {
  return (await d1UsageOn(db, utcDay(now))).written >= writeSoftCap(env);
}

/** 오래된 날짜의 사용량 키를 지운다 (meta가 날마다 2행씩 늘지 않게) */
export async function pruneD1Usage(db: D1Database, beforeDay: string): Promise<void> {
  await db
    .prepare("DELETE FROM meta WHERE (key LIKE 'd1_read:%' OR key LIKE 'd1_written:%') AND substr(key, -10) < ?")
    .bind(beforeDay)
    .run();
}
