import type { FpKind } from "../shared/adaptiveRefresh";
import { utcDay } from "../shared/kst";

/**
 * R38 D1 읽기 예산. 무료 플랜은 하루 읽기 5,000,000행이 넘으면 그날 D1이 멈춘다.
 * 요청·Cron 실행마다 D1 결과의 meta.rows_read/rows_written을 메모리에 모으고, 끝날 때 한 번만 meta에 더한다.
 * 한도는 UTC 자정(KST 09:00)에 초기화되므로 날짜 키도 UTC 날짜다 ("wait until tomorrow (midnight UTC)").
 */
export type D1Usage = { read: number; written: number; calls?: number; details?: DetailTally };

/**
 * R66 관리 화면 계수: 이번 실행이 저장한 상세를 지난번 지문과 비교한 수 (같음·바뀜·처음). 실행 끝의 사용량 기록 문장에
 * 같이 더한다 — meta detail_{same|changed|first}:{UTC 날짜} (계수 때문에 D1 문장이 늘지 않는다)
 */
export type DetailTally = Record<FpKind, number>;
export const newTally = (): DetailTally => ({ same: 0, changed: 0, first: 0 });
export const DETAIL_KINDS: readonly FpKind[] = ["same", "changed", "first"];
export const detailCounterKey = (kind: FpKind, day: string) => `detail_${kind}:${day}`;
/** 사용량 기록 문장에 더할 [key, value] (0인 계수는 빼서 쓰기 행을 늘리지 않는다) */
const tallyPairs = (usage: D1Usage, day: string): string[] =>
  DETAIL_KINDS.flatMap((k) => ((usage.details?.[k] ?? 0) > 0 ? [detailCounterKey(k, day), String(usage.details![k])] : []));

export const DEFAULT_READ_SOFT_CAP = 3_000_000;
/** 하루 쓰기 100,000행 중 이벤트 수집(R35)이 넘지 않게 멈추는 선 */
export const DEFAULT_WRITE_SOFT_CAP = 60_000;
const readKey = (day: string) => `d1_read:${day}`;
const writtenKey = (day: string) => `d1_written:${day}`;

/** D1 호출 하나 (Task 34: 실행당 질의 수 한도 — batch()는 왕복 하나라 한 번) */
const counted = (usage: D1Usage) => {
  usage.calls = (usage.calls ?? 0) + 1;
};

/**
 * Task 34: 실행 하나가 쓸 수 있는 D1 호출 수 (무료 플랜 Worker 실행당 D1 질의 50개). meteredDb가 센 usage.calls로 남은 수를 본다.
 * 단계마다 has(n)으로 확인하고, 모자라면 그 단계를 줄이거나 건너뛴다 (다음 실행이 이어 한다)
 */
export class D1CallBudget {
  constructor(private readonly usage: D1Usage, readonly limit: number) {}
  get used(): number {
    return this.usage.calls ?? 0;
  }
  get left(): number {
    return Math.max(0, this.limit - this.used);
  }
  has(n: number): boolean {
    return this.left >= n;
  }
}

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
    counted(this.usage);
    const r = await this.inner.all<T>();
    add(this.usage, r.meta);
    return r;
  }
  async run<T>() {
    counted(this.usage);
    const r = await this.inner.run<T>();
    add(this.usage, r.meta);
    return r;
  }
  /** D1의 first()도 쿼리 전체를 실행하고 첫 행만 돌려준다. meta를 얻으려고 all()로 대신한다 */
  async first<T>(colName?: string): Promise<T | null> {
    counted(this.usage);
    const r = await this.inner.all<Record<string, unknown>>();
    add(this.usage, r.meta);
    const row = r.results[0];
    if (!row) return null;
    return (colName === undefined ? row : (row[colName] ?? null)) as T | null;
  }
  raw<T>(options?: { columnNames?: boolean }) {
    counted(this.usage);
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
      counted(usage);
      const rs = await db.batch<T>(statements.map(unwrap));
      for (const r of rs) add(usage, r.meta);
      return rs;
    },
    exec: (query: string) => {
      counted(usage);
      return db.exec(query);
    },
    withSession: (c?: string) => db.withSession(c),
    dump: () => db.dump(),
  };
  return wrapped as unknown as D1Database;
}

/** 더하는 UPSERT (n쌍) — 사용량 2쌍 + R66 계수 0~3쌍 */
const addUpsert = (pairs: number) => `INSERT INTO meta (key, value) VALUES ${Array.from({ length: pairs }, () => "(?, ?)").join(", ")}
  ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + CAST(excluded.value AS INTEGER)`;

/** 이벤트 한 개를 넣을 때 쓰는 행 수 (표 + 인덱스 2 + 일련번호; 로컬 측정) */
export const EVENT_ROWS_WRITTEN = 4;

/** 오늘(UTC) 쓰기 추정치만 더하는 문장 (R35 이벤트 배치에 같이 넣는다) */
export function addWrittenStatement(db: D1Database, rows: number, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + CAST(excluded.value AS INTEGER)`,
    )
    .bind(writtenKey(utcDay(now)), String(Math.round(rows)));
}

/** 오늘(UTC) 사용량(+ R66 계수)에 더한다 — UPSERT 한 문장. 이 기록 자체(몇 행)는 세지 않는다 */
export async function recordD1Usage(db: D1Database, usage: D1Usage, now: number): Promise<void> {
  const day = utcDay(now);
  const tally = tallyPairs(usage, day);
  if (usage.read <= 0 && usage.written <= 0 && tally.length === 0) return;
  await db
    .prepare(addUpsert(2 + tally.length / 2))
    .bind(readKey(day), String(Math.round(usage.read)), writtenKey(day), String(Math.round(usage.written)), ...tally)
    .run();
}

/** R59 Cron 마지막 실행 요약을 두는 meta 키 */
export const CRON_LAST_KEY = "cron_last";
/** R63: 둘째 트리거의 상세만 실행(홀수 분)의 마지막 요약 */
export const CRON_DETAIL_LAST_KEY = "cron_detail_last";

/**
 * R38 + R59: Cron 실행의 사용량 기록과 마지막 실행 요약(cron_last)을 UPSERT 한 문장으로 쓴다 (요약 때문에 늘어나는 쓰기는 실행당 1행).
 * 사용량과 R66 계수(0이 아닌 것만)는 더하고, 요약은 바꿔 쓴다
 */
export async function recordCronRun(
  db: D1Database, usage: D1Usage, now: number, summary: object,
  /** 요약을 둘 meta 키 (본 Cron cron_last, R63 상세만 실행 cron_detail_last) */
  summaryKey: typeof CRON_LAST_KEY | typeof CRON_DETAIL_LAST_KEY = CRON_LAST_KEY,
): Promise<void> {
  const day = utcDay(now);
  const tally = tallyPairs(usage, day);
  await db
    .prepare(
      // summaryKey는 코드의 상수 둘 중 하나다 (밖에서 오는 값이 아니다)
      `INSERT INTO meta (key, value) VALUES (?, ?), (?, ?), ('${summaryKey}', ?)${", (?, ?)".repeat(tally.length / 2)}
       ON CONFLICT(key) DO UPDATE SET value = CASE WHEN meta.key = '${summaryKey}' THEN excluded.value
         ELSE CAST(meta.value AS INTEGER) + CAST(excluded.value AS INTEGER) END`,
    )
    .bind(
      readKey(day), String(Math.round(usage.read)), writtenKey(day), String(Math.round(usage.written)), JSON.stringify(summary),
      ...tally,
    )
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

/** D1 질의 하나의 바인드 값 상한(100)보다 넉넉히 작은 수 — 이보다 많은 키는 json_each 목록으로 */
const META_IN_MAX = 90;

/**
 * meta 여러 키를 한 질의로 읽는 문장. 키마다 기본 키로 찾는 자리표 목록(IN (?, …))이다 — Task 57: json_each 목록은 키마다 ~3행을
 * 읽어서(본 Cron 시작·격자 수집 뒤 두 번에 71~76행) 자리표로 바꿨다. 키가 META_IN_MAX보다 많으면 예전처럼 json_each
 */
export function metaKeysStmt(db: D1Database, keys: readonly string[]): D1PreparedStatement {
  return keys.length <= META_IN_MAX
    ? db.prepare(`SELECT key, value FROM meta WHERE key IN (${keys.map(() => "?").join(", ")})`).bind(...keys)
    : db.prepare("SELECT key, value FROM meta WHERE key IN (SELECT value FROM json_each(?))").bind(JSON.stringify(keys));
}

/**
 * Task 40: 오늘(UTC) 읽기 행 수와 meta 몇 키를 한 질의로 (본 Cron 시작 — 읽기 예산 확인과 격자 확인 표시를 D1 호출 하나로)
 */
export async function readTodayAndMeta(
  db: D1Database, now: number, keys: readonly string[],
): Promise<{ read: number; meta: Map<string, string> }> {
  const day = readKey(utcDay(now));
  const r = await metaKeysStmt(db, [day, ...keys]).all<{ key: string; value: string }>();
  const meta = new Map(r.results.map((x) => [x.key, x.value] as const));
  const read = Number(meta.get(day) ?? 0);
  meta.delete(day);
  return { read: Number.isFinite(read) ? read : 0, meta };
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

/** 오래된 날짜의 사용량·R66 계수 키를 지운다 (meta가 날마다 2~5행씩 늘지 않게) */
export async function pruneD1Usage(db: D1Database, beforeDay: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM meta WHERE (key LIKE 'd1_read:%' OR key LIKE 'd1_written:%' OR key LIKE 'detail_same:%' OR key LIKE 'detail_changed:%'
         OR key LIKE 'detail_first:%') AND substr(key, -10) < ?`,
    )
    .bind(beforeDay)
    .run();
}
