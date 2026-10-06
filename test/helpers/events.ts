import { env } from "cloudflare:test";
import { kstDayHour } from "../../shared/kst";

export type Seed = { anon: string; session: string; ts: number; hub: string; type: string; placeId?: string; props?: object };

/** 이벤트를 저장 형식(KST 날짜·시 포함) 그대로 넣는다 */
export async function seedEvents(list: Seed[], db: D1Database = env.DB) {
  const stmt = db.prepare(
    "INSERT INTO events (ts, day, hour, anon, session, hub, type, place_id, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < list.length; i += 50) {
    await db.batch(
      list.slice(i, i + 50).map((e) => {
        const { day, hour } = kstDayHour(e.ts);
        return stmt.bind(e.ts, day, hour, e.anon, e.session, e.hub, e.type, e.placeId ?? null, e.props ? JSON.stringify(e.props) : null);
      }),
    );
  }
}

/** n번째 익명 id·세션 id (형식만 맞는 값) */
export const anonN = (n: number) => `a${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;
export const sessN = (n: number) => `5${String(n).padStart(7, "0")}-0000-4000-8000-000000000000`;

/** 하루치 지표 행 → {"hub metric": value} */
export const metricMap = (rows: { hub: string; metric: string; value: number }[]) =>
  Object.fromEntries(rows.map((r) => [`${r.hub} ${r.metric}`, r.value]));
