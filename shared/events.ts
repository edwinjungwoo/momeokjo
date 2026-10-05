import { z } from "zod";
import { FILTER_GROUPS } from "./category";
import { isValidRadius } from "./constants";
import { isHubId } from "./hubs";
import { kstDayHour } from "./kst";
import type { CategoryGroup } from "./types";

/**
 * R35 익명 사용 이벤트. 로그인 없이 브라우저마다 무작위 id(anon)와 탭 세션 id(session)만 보낸다.
 * IP, User-Agent, 정확한 위치, 자유 입력 글자는 받지도 저장하지도 않는다. 90일 뒤 지운다.
 */
export const EVENT_TYPES = [
  "app_open", // 세션마다 한 번
  "draw", // 첫 뽑기 (결과가 없을 때)
  "redraw", // 결과가 떠 있는 상태에서 다시 뽑기
  "share", // 공유·복사 성공 (picks = 공유한 곳)
  "open_kakao", // 카카오맵 열기 (rank = 결과 3곳 중 몇 번째인지)
  "select_place", // 목록·지도 핀에서 한 곳을 엶
  "hub_change",
  "filter_change", // 1초 디바운스, 바뀐 뒤의 필터 스냅숏
  "empty_result", // 필터를 바꾼 뒤 후보가 0곳이 됨
  "expand_card", // 결과 카드를 펼침 (rank)
  "exclude_place", // "여긴 빼줘"
  "undo_exclude", // "되돌리기"
  "share_open", // 받은 공유 링크(t=)를 엶 (picks)
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const ANON_KEY = "mmj:anon:v1";
export const SESSION_KEY = "mmj:session:v1";
export const SESSION_IDLE_MS = 30 * 60_000;
export const MAX_EVENTS_PER_REQUEST = 20;
export const MAX_EVENT_BODY_BYTES = 8 * 1024;
/** 클라이언트 시각이 서버 시각과 이만큼 넘게 다르면 서버 시각을 쓴다 */
export const TS_SKEW_MS = 10 * 60_000;
export const EVENT_RETENTION_DAYS = 90;

const PLACE_ID = /^\d{1,15}$/;
const UUIDISH = /^[0-9a-f-]{36}$/;
const GROUPS = FILTER_GROUPS as [CategoryGroup, ...CategoryGroup[]];

export const EventPropsSchema = z.strictObject({
  radius: z.number().refine(isValidRadius).optional(),
  party: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  groups: z.array(z.enum(GROUPS)).max(GROUPS.length).optional(),
  priceCap: z.enum(["all", "10000", "15000", "20000"]).optional(),
  minRating: z.union([z.literal(0), z.literal(3.5), z.literal(4)]).optional(),
  openOnly: z.boolean().optional(),
  candidates: z.number().int().min(0).max(5000).optional(),
  picks: z.array(z.string().regex(PLACE_ID)).max(3).optional(),
  rank: z.number().int().min(1).max(3).optional(),
});
export type EventProps = z.infer<typeof EventPropsSchema>;

export const EventSchema = z.strictObject({
  t: z.enum(EVENT_TYPES),
  ts: z.number().finite(),
  hub: z.string().refine(isHubId),
  placeId: z.string().regex(PLACE_ID).optional(),
  props: EventPropsSchema.optional(),
});
export type TrackedEvent = z.infer<typeof EventSchema>;

const BatchSchema = z.strictObject({
  anon: z.string().regex(UUIDISH),
  session: z.string().regex(UUIDISH),
  events: z.array(z.unknown()).min(1).max(MAX_EVENTS_PER_REQUEST),
});

/** D1 한 행 (day, hour는 GROUP BY를 싸게 하려고 미리 계산한 KST 값) */
export type StoredEvent = {
  ts: number;
  day: string;
  hour: number;
  hub: string;
  type: EventType;
  placeId: string | null;
  props: string | null;
};

export const clampTs = (ts: number, now: number) => (Math.abs(ts - now) <= TS_SKEW_MS ? Math.round(ts) : now);

export function toStored(e: TrackedEvent, now: number): StoredEvent {
  const ts = clampTs(e.ts, now);
  const { day, hour } = kstDayHour(ts);
  const props = e.props && Object.keys(e.props).length > 0 ? JSON.stringify(e.props) : null;
  return { ts, day, hour, hub: e.hub, type: e.t, placeId: e.placeId ?? null, props };
}

/** 봉투(anon, session, 1~20개)가 틀리면 null. 이벤트 하나하나는 검증해서 틀린 것만 조용히 버리고 센다 */
export function parseEventBatch(
  json: unknown, now: number,
): { anon: string; session: string; events: StoredEvent[]; dropped: number } | null {
  const b = BatchSchema.safeParse(json);
  if (!b.success) return null;
  const events: StoredEvent[] = [];
  let dropped = 0;
  for (const raw of b.data.events) {
    const e = EventSchema.safeParse(raw);
    if (e.success) events.push(toStored(e.data, now));
    else dropped += 1;
  }
  return { anon: b.data.anon, session: b.data.session, events, dropped };
}

/** 탭 세션: 저장된 {id, at}이 30분 안이면 이어 쓰고, 아니면 새로 만든다. stored는 다시 저장할 값 */
export function nextSession(
  raw: string | null, now: number, newId: () => string,
): { id: string; isNew: boolean; stored: string } {
  let prev: { id?: unknown; at?: unknown } | null = null;
  try {
    prev = raw ? JSON.parse(raw) : null;
  } catch {
    prev = null;
  }
  const alive =
    prev !== null && typeof prev.id === "string" && UUIDISH.test(prev.id) && typeof prev.at === "number" &&
    now - prev.at <= SESSION_IDLE_MS && now >= prev.at - TS_SKEW_MS;
  const id = alive ? (prev!.id as string) : newId();
  return { id, isNew: !alive, stored: JSON.stringify({ id, at: now }) };
}

/** R36 GET /api/admin/stats 응답 */
export type DayStats = {
  day: string;
  users: number;
  sessions: number;
  draws: number;
  redraws: number;
  shares: number;
  openKakao: number;
  shareOpens: number;
};
export type StatsResponse = {
  range: { from: string; to: string; days: number; hub: string };
  /** 오래된 날부터, 빈 날도 0으로 채운다 */
  daily: DayStats[];
  totals: Omit<DayStats, "day"> & { expands: number; excludes: number };
  /** KST 시(0–23)별 뽑기(draw + redraw) */
  hourly: number[];
  hubs: { hub: string; users: number; sessions: number; draws: number; shares: number }[];
  top: { placeId: string; name: string | null; count: number }[];
  /** 결과 카드 번호(1~3)별: 펼침, 카카오맵 열기, 빼줘 */
  ranks: { expand: number[]; kakao: number[]; exclude: number[] };
  /** 뽑기한 세션 중 공유 / 카카오맵까지 간 세션 비율 (뽑기 세션이 없으면 null) */
  conversion: { drawSessions: number; toShare: number | null; toKakao: number | null };
  drawsPerSession: number | null;
  d1Today: { read: number; written: number; readSoftCap: number };
};
