/** 테스트용: 실행된 SQL과 결과 meta(rows_read/rows_written)를 기록하는 D1Database 감싸개 */
export type Executed = { sql: string; read: number; written: number };

class RecStatement {
  constructor(readonly inner: D1PreparedStatement, readonly sql: string, private readonly log: Executed[]) {}
  bind(...values: unknown[]) {
    return new RecStatement(this.inner.bind(...values), this.sql, this.log);
  }
  private note(meta: Partial<D1Meta> | undefined) {
    this.log.push({ sql: this.sql, read: Number(meta?.rows_read ?? 0), written: Number(meta?.rows_written ?? 0) });
  }
  async all<T>() {
    const r = await this.inner.all<T>();
    this.note(r.meta);
    return r;
  }
  async run<T>() {
    const r = await this.inner.run<T>();
    this.note(r.meta);
    return r;
  }
  async first<T>(col?: string): Promise<T | null> {
    const r = await this.inner.all<Record<string, unknown>>();
    this.note(r.meta);
    const row = r.results[0];
    if (!row) return null;
    return (col === undefined ? row : (row[col] ?? null)) as T | null;
  }
}

export function recordingDb(db: D1Database): { db: D1Database; log: Executed[] } {
  const log: Executed[] = [];
  const wrapped = {
    prepare: (sql: string) => new RecStatement(db.prepare(sql), sql, log) as unknown as D1PreparedStatement,
    batch: async <T>(stmts: D1PreparedStatement[]) => {
      const recs = stmts as unknown as RecStatement[];
      const rs = await db.batch<T>(recs.map((s) => s.inner));
      rs.forEach((r, i) =>
        log.push({ sql: recs[i].sql, read: Number(r.meta?.rows_read ?? 0), written: Number(r.meta?.rows_written ?? 0) }),
      );
      return rs;
    },
  };
  return { db: wrapped as unknown as D1Database, log };
}
