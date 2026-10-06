import { z } from "zod";
import { FILTER_GROUPS } from "./category";
import { isValidRadius } from "./constants";
import { isHubId } from "./hubs";
import { EVENT_TYPES, MAX_EVENTS_PER_REQUEST, UUIDISH, clampTs, type EventType } from "./eventCore";
import { kstDayHour } from "./kst";
import type { CategoryGroup } from "./types";

export * from "./eventCore";

const PLACE_ID = /^\d{1,15}$/;
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
  /** R39 열자마자 자동으로 뽑은 draw */
  auto: z.literal(true).optional(),
  /** R47 펼친 카드의 "여기로 가자고 공유"(한 곳 확정)로 보낸 share (R58: rank도 같이 보낸다) */
  confirm: z.literal(true).optional(),
  /** R58 R41 완화로 조건 밖 가게가 섞인 draw·redraw */
  relaxed: z.literal(true).optional(),
  /** R61 첫 접속 질문에서 거점을 고른 hub_change */
  onboarding: z.literal(true).optional(),
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
  /**
   * draws·redraws는 사용자가 직접 한 뽑기만. autoDraws = R39 자동 뽑기 (뽑기 수·전환율·시간대·거점·상위 가게에는 넣지 않는다).
   * confirmShares = R47 "여기로 가자고 공유" 확정 공유 (shares에도 들어 있다)
   */
  totals: Omit<DayStats, "day"> & { expands: number; excludes: number; autoDraws: number; confirmShares: number };
  /** KST 시(0–23)별 직접 한 뽑기(draw + redraw, 자동 뽑기 제외) */
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
