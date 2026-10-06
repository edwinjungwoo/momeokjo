/**
 * R52: 개발 서버는 운영 D1을 읽기만 한다.
 * wrangler.jsonc의 D1 바인딩이 `"remote": true`라서 `vite dev`도 운영 D1에 붙는다. vite.config.ts가 dev 서버에서만
 * `READ_ONLY=1`을 넣고(빌드 결과·운영에는 없다), Worker 입구(worker/index.ts)가 그때 DB를 이 감싸개로 바꾼다.
 * 앱은 쓰기 경로(수집·보충·사용량 기록·이벤트·관리자 쓰기·Cron)를 먼저 건너뛰고, 이 감싸개는 빠뜨린 쓰기를 실행 전에 막는 안전망이다.
 */

/**
 * 비어 있지 않은 값이 "0"·"false"가 아니면 켠다 (실패하면 닫히는 쪽 — "true"·"yes"·오타도 읽기 전용이 된다).
 * 값이 없거나 공백뿐이거나 "0"·"false"일 때만 끈다.
 */
export const isReadOnly = (env: Env): boolean => {
  const v = (env as unknown as Record<string, unknown>).READ_ONLY;
  if (v === undefined || v === null) return false;
  const t = String(v).trim().toLowerCase();
  return t !== "" && t !== "0" && t !== "false";
};

let noticed = false;
/** R52: 읽기 전용 모드가 켜져 있으면 격리(isolate) 하나에 한 번만 알린다 — dev 서버가 운영 D1을 읽기만 하는 중임을 로그에 남긴다 */
export function logReadOnlyOnce(env: Env): void {
  if (noticed || !isReadOnly(env)) return;
  noticed = true;
  console.log("[read-only] 운영 D1 읽기 전용 모드");
}
/** 테스트용 */
export const resetReadOnlyNoticeForTest = (): void => {
  noticed = false;
};

/** 읽기 전용 D1에서 쓰기(또는 확인할 수 없는) 문장을 실행하려 했다 */
export class ReadOnlyViolation extends Error {
  constructor(keyword: string, sql: string) {
    super(`READ_ONLY=1: D1 write blocked (${keyword}): ${sql.replace(/\s+/g, " ").trim().slice(0, 120)}`);
    this.name = "ReadOnlyViolation";
  }
}

type Token = { kind: "word" | "name" | "punct"; text: string };

/** 주석·공백은 버리고, 문자열과 따옴표 이름은 키워드로 읽히지 않게 한 덩어리로 묶는다 */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < n) {
        if (sql[j] === close) {
          // '' "" `` 는 같은 따옴표를 글자로 쓴 것
          if (close !== "]" && sql[j + 1] === close) j += 2;
          else break;
        } else j += 1;
      }
      tokens.push({ kind: c === "'" ? "punct" : "name", text: sql.slice(i, j + 1) });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j += 1;
      tokens.push({ kind: "word", text: sql.slice(i, j).toUpperCase() });
      i = j;
    } else {
      tokens.push({ kind: "punct", text: c });
      i += 1;
    }
  }
  return tokens;
}

/** 최상위 `;`로 문장을 나눈다 (괄호 안의 `;`는 없지만 깊이를 같이 센다) */
function statements(tokens: Token[]): Token[][] {
  const out: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.text === "(") depth += 1;
    if (t.text === ")") depth = Math.max(0, depth - 1);
    if (t.text === ";" && depth === 0) out.push([]);
    else out[out.length - 1].push(t);
  }
  return out.filter((s) => s.length > 0);
}

const READ_STARTS = new Set(["SELECT", "VALUES", "EXPLAIN"]);
const CTE_MAIN = new Set(["SELECT", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE"]);
/** 인자를 괄호로 받아도 읽기만 하는 PRAGMA */
const READ_PRAGMA_CALLS = new Set([
  "TABLE_INFO", "TABLE_XINFO", "TABLE_LIST", "INDEX_INFO", "INDEX_XINFO", "INDEX_LIST", "FOREIGN_KEY_LIST",
  "FOREIGN_KEY_CHECK", "INTEGRITY_CHECK", "QUICK_CHECK",
]);
/** 인자 없이도 무언가를 바꾸는 PRAGMA */
const WRITE_PRAGMAS = new Set(["OPTIMIZE", "INCREMENTAL_VACUUM", "WAL_CHECKPOINT"]);

function pragmaWrites(rest: Token[]): boolean {
  if (rest.some((t) => t.text === "=")) return true;
  // [schema.]name
  const words = rest[1]?.text === "." ? [rest[0], rest[2]] : [rest[0]];
  const name = words[words.length - 1]?.text ?? "";
  const after = rest[words.length === 2 ? 3 : 1];
  if (after?.text === "(") return !READ_PRAGMA_CALLS.has(name);
  return WRITE_PRAGMAS.has(name);
}

/** 한 문장이 쓰기면 그 키워드, 읽기면 null */
function statementWrite(tokens: Token[]): string | null {
  const head = tokens[0].text;
  if (READ_STARTS.has(head)) return null;
  if (head === "PRAGMA") return pragmaWrites(tokens.slice(1)) ? "PRAGMA" : null;
  if (head === "WITH") {
    // CTE 본문은 모두 괄호 안이다 — 괄호 밖에서 처음 나오는 문장 키워드가 실제로 실행되는 문장이다
    let depth = 0;
    for (const t of tokens.slice(1)) {
      if (t.text === "(") depth += 1;
      else if (t.text === ")") depth -= 1;
      else if (depth === 0 && t.kind === "word" && CTE_MAIN.has(t.text)) return READ_STARTS.has(t.text) ? null : t.text;
    }
    return "WITH";
  }
  // 그 밖의 모든 문장(INSERT·UPDATE·DELETE·REPLACE·CREATE·DROP·ALTER·VACUUM·ANALYZE·REINDEX·ATTACH 등)은 쓰기로 본다
  return head;
}

/**
 * R52: SQL(여러 문장일 수 있다)이 D1에 쓰면 처음 걸린 문장의 키워드(대문자), 읽기만 하면 null.
 * 주석·공백·`WITH ...` CTE를 건너뛰고 실제 문장 키워드를 본다. 아는 읽기 형태(SELECT·VALUES·EXPLAIN·읽기 PRAGMA)만 통과한다.
 */
export function writeKeyword(sql: string): string | null {
  for (const s of statements(tokenize(sql))) {
    const w = statementWrite(s);
    if (w !== null) return w;
  }
  return null;
}

function assertRead(sql: string): void {
  const w = writeKeyword(sql);
  if (w !== null) throw new ReadOnlyViolation(w, sql);
}

/** 확인한 SQL을 들고 다니는 문장 — batch가 출처와 SQL을 다시 확인할 수 있게 */
class ReadOnlyStatement {
  constructor(readonly inner: D1PreparedStatement, readonly sql: string) {}
  bind(...values: unknown[]) {
    return new ReadOnlyStatement(this.inner.bind(...values), this.sql);
  }
  first<T>(colName?: string): Promise<T | null> {
    return colName === undefined ? this.inner.first<T>() : this.inner.first<T>(colName);
  }
  all<T>() {
    return this.inner.all<T>();
  }
  run<T>() {
    return this.inner.run<T>();
  }
  raw<T>(options?: { columnNames?: boolean }) {
    return this.inner.raw<T>(options as { columnNames?: false });
  }
}

type Preparer = Pick<D1Database, "prepare" | "batch">;

function guarded<T extends Preparer>(db: T) {
  return {
    prepare: (query: string) => {
      assertRead(query);
      return new ReadOnlyStatement(db.prepare(query), query) as unknown as D1PreparedStatement;
    },
    batch: async <R>(statements: D1PreparedStatement[]) => {
      const inner = statements.map((s) => {
        if (!((s as unknown) instanceof ReadOnlyStatement)) {
          throw new ReadOnlyViolation("BATCH", "statement not prepared through the read-only D1");
        }
        const r = s as unknown as ReadOnlyStatement;
        assertRead(r.sql);
        return r.inner;
      });
      return db.batch<R>(inner);
    },
  };
}

/** R52: 쓰기 문장을 실행 전에 막는 D1Database (같은 인터페이스). SELECT 등 읽기는 그대로 실행한다 */
export function readOnlyDb(db: D1Database): D1Database {
  const wrapped = {
    ...guarded(db),
    // D1 exec는 줄바꿈으로 문장을 나눠 실행하므로("SELECT 1\nDELETE ...") SQL 분류를 믿을 수 없다. 앱은 exec를 쓰지 않으니 항상 막는다
    exec: async (query: string): Promise<D1ExecResult> => {
      throw new ReadOnlyViolation("EXEC", query);
    },
    withSession: (constraintOrBookmark?: string) => {
      const session = db.withSession(constraintOrBookmark);
      return { ...guarded(session), getBookmark: () => session.getBookmark() } as unknown as D1DatabaseSession;
    },
    dump: () => db.dump(),
  };
  return wrapped as unknown as D1Database;
}

/** R52: Worker 입구에서 쓴다 — READ_ONLY=1이면 DB만 읽기 전용으로 바꾼 env, 아니면 env 그대로 */
export function readOnlyEnv(env: Env): Env {
  return isReadOnly(env) ? { ...env, DB: readOnlyDb(env.DB) } : env;
}
