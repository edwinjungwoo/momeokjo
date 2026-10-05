/**
 * R46: 이 기기에서 결과·카드로 보여준 곳 (id → 마지막으로 본 시각). "처음 보는 곳"이 글자 그대로 참이게 한다.
 * 기기의 localStorage에만 두고(`web/seen.ts`) 서버로 보내지 않는다. 30일 지나면 잊고, 최대 500곳(넘치면 가장 오래전에 본 곳부터 버림).
 */
export type Seen = Readonly<Record<string, number>>;

const DAY = 24 * 3600_000;
export const SEEN_TTL_MS = 30 * DAY;
export const MAX_SEEN = 500;

const PLACE_ID = /^\d{1,15}$/;

/** 30일 지난 곳을 버리고 최근에 본 500곳만 남긴다. 미래 시각(시계 어긋남)은 방금 본 것으로 보고 남긴다 */
export function pruneSeen(s: Seen, now: number): Seen {
  const live = Object.entries(s).filter(([, at]) => now - at <= SEEN_TTL_MS);
  if (live.length > MAX_SEEN) live.sort((a, b) => b[1] - a[1]).splice(MAX_SEEN);
  return Object.fromEntries(live);
}

/** 보여준 곳들의 마지막으로 본 시각을 now로 (원래 객체는 바꾸지 않는다) */
export function markSeen(s: Seen, ids: readonly string[], now: number): Seen {
  if (ids.length === 0) return s;
  const next: Record<string, number> = { ...s };
  for (const id of ids) next[id] = now;
  return pruneSeen(next, now);
}

/** 이 기기에서 아직 보여준 적 없는 곳인가 */
export const isNew = (s: Seen, id: string): boolean => !Object.hasOwn(s, id);

/** localStorage 값 → 기억. 깨진 값은 버리고 올바른 항목만 남긴다 */
export function parseSeen(raw: string | null): Seen {
  if (!raw) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return {};
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(json)) {
    if (PLACE_ID.test(id) && typeof at === "number" && Number.isFinite(at)) out[id] = at;
  }
  return out;
}
