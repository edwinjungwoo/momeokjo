import { describe, expect, it } from "vitest";
import {
  EventSchema, SESSION_IDLE_MS, TS_SKEW_MS, clampTs, nextSession, parseEventBatch, toStored,
} from "../../shared/events";
import { kstDayHour } from "../../shared/kst";

const NOW = 1_800_000_000_000; // 2027-01-15 17:00 KST
const ANON = "0b0e7c6e-3f6b-4b8e-9a3e-1c2d3e4f5a6b";
const SESSION = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ev = (o: Record<string, unknown> = {}) => ({ t: "draw", ts: NOW, hub: "bongeunsa", ...o });

describe("events", () => {
  it("R35: KST 날짜·시는 UTC+9로 계산한다 (자정 경계 포함)", () => {
    expect(kstDayHour(NOW)).toEqual({ day: "2027-01-15", hour: 17 });
    expect(kstDayHour(Date.UTC(2027, 0, 14, 14, 59))).toEqual({ day: "2027-01-14", hour: 23 });
    expect(kstDayHour(Date.UTC(2027, 0, 14, 15, 0))).toEqual({ day: "2027-01-15", hour: 0 });
  });

  it("R35: 클라이언트 시각은 서버 시각 ±10분 안이면 쓰고, 벗어나면 서버 시각을 쓴다", () => {
    expect(clampTs(NOW - TS_SKEW_MS, NOW)).toBe(NOW - TS_SKEW_MS);
    expect(clampTs(NOW + TS_SKEW_MS, NOW)).toBe(NOW + TS_SKEW_MS);
    expect(clampTs(NOW - TS_SKEW_MS - 1, NOW)).toBe(NOW);
    expect(clampTs(NOW + TS_SKEW_MS + 1, NOW)).toBe(NOW);
    expect(clampTs(0, NOW)).toBe(NOW);
  });

  it("R35: 알려진 타입·거점·필드만 받는다 (그 밖의 키는 거부)", () => {
    expect(EventSchema.safeParse(ev()).success).toBe(true);
    expect(
      EventSchema.safeParse(
        ev({
          placeId: "12345",
          props: {
            radius: 500, party: 4, groups: ["korean", "etc"], priceCap: "10000", minRating: 3.5, openOnly: true,
            candidates: 120, picks: ["1", "22", "333"], rank: 2,
          },
        }),
      ).success,
    ).toBe(true);
    const bad = [
      ev({ t: "purchase" }),
      ev({ hub: "atlantis" }),
      ev({ placeId: "12a" }),
      ev({ placeId: "1234567890123456" }),
      ev({ ts: "now" }),
      ev({ text: "자유 입력" }),
      ev({ props: { radius: 333 } }),
      ev({ props: { party: 5 } }),
      ev({ props: { groups: ["bar"] } }),
      ev({ props: { priceCap: "9000" } }),
      ev({ props: { minRating: 5 } }),
      ev({ props: { candidates: 5001 } }),
      ev({ props: { candidates: 1.5 } }),
      ev({ props: { picks: ["1", "2", "3", "4"] } }),
      ev({ props: { picks: ["x"] } }),
      ev({ props: { rank: 4 } }),
      ev({ props: { ua: "Mozilla" } }),
    ];
    for (const b of bad) expect(EventSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
  });

  it("R39: 자동 뽑기의 draw는 props.auto: true만 받는다", () => {
    expect(EventSchema.safeParse(ev({ props: { auto: true, candidates: 10, picks: ["1"] } })).success).toBe(true);
    expect(EventSchema.safeParse(ev({ props: { auto: false } })).success).toBe(false);
    expect(EventSchema.safeParse(ev({ props: { auto: "yes" } })).success).toBe(false);
  });

  it("R58: R41 완화가 섞인 뽑기는 props.relaxed: true만 받는다", () => {
    expect(EventSchema.safeParse(ev({ props: { relaxed: true, picks: ["1"] } })).success).toBe(true);
    expect(EventSchema.safeParse(ev({ props: { relaxed: false } })).success).toBe(false);
    expect(EventSchema.safeParse(ev({ props: { relaxed: 1 } })).success).toBe(false);
  });

  it("R58: 확정 공유는 결과 카드 번호(rank 1~3)를 함께 받는다", () => {
    expect(EventSchema.safeParse(ev({ t: "share", placeId: "1", props: { confirm: true, picks: ["1"], rank: 2 } })).success).toBe(true);
    expect(EventSchema.safeParse(ev({ t: "share", placeId: "1", props: { confirm: true, rank: 4 } })).success).toBe(false);
  });

  it("R47: 확정 공유의 share는 props.confirm: true만 받는다", () => {
    expect(EventSchema.safeParse(ev({ t: "share", placeId: "1", props: { confirm: true, picks: ["1"] } })).success).toBe(true);
    expect(EventSchema.safeParse(ev({ t: "share", props: { confirm: false } })).success).toBe(false);
    expect(EventSchema.safeParse(ev({ t: "share", props: { confirm: "yes" } })).success).toBe(false);
  });

  it("R61: 첫 접속 거점 고르기의 hub_change는 props.onboarding: true만 받는다", () => {
    expect(EventSchema.safeParse(ev({ t: "hub_change", hub: "pangyo", props: { onboarding: true } })).success).toBe(true);
    expect(EventSchema.safeParse(ev({ t: "hub_change", props: { onboarding: false } })).success).toBe(false);
    expect(EventSchema.safeParse(ev({ t: "hub_change", props: { onboarding: "yes" } })).success).toBe(false);
  });

  it("R35: 저장 행은 서버 기준 시각, KST 날짜·시, 짧은 props JSON(없으면 null)", () => {
    const late = Date.UTC(2027, 0, 14, 15, 3);
    expect(toStored({ t: "share", ts: late, hub: "ddp", props: { picks: ["1", "2"] } }, late + 60_000)).toEqual({
      ts: late, day: "2027-01-15", hour: 0, hub: "ddp", type: "share", placeId: null, props: '{"picks":["1","2"]}',
    });
    expect(toStored({ t: "app_open", ts: 1, hub: "ddp", props: {} }, NOW)).toMatchObject({
      ts: NOW, day: "2027-01-15", hour: 17, props: null,
    });
  });

  it("R35: 봉투가 틀리면 null, 이벤트는 틀린 것만 버리고 센다", () => {
    const ok = parseEventBatch({ anon: ANON, session: SESSION, events: [ev(), ev({ t: "nope" }), ev({ hub: "x" })] }, NOW);
    expect(ok?.events).toHaveLength(1);
    expect(ok?.dropped).toBe(2);
    expect(ok).toMatchObject({ anon: ANON, session: SESSION });

    expect(parseEventBatch({ anon: "me", session: SESSION, events: [ev()] }, NOW)).toBeNull();
    expect(parseEventBatch({ anon: ANON, session: SESSION, events: [] }, NOW)).toBeNull();
    expect(parseEventBatch({ anon: ANON, session: SESSION, events: Array(21).fill(ev()) }, NOW)).toBeNull();
    expect(parseEventBatch({ anon: ANON, session: SESSION, events: [ev()], ip: "1.2.3.4" }, NOW)).toBeNull();
    expect(parseEventBatch("x", NOW)).toBeNull();
  });

  it("R35: 탭 세션은 30분 동안 아무 일이 없으면 새로 만든다", () => {
    const newId = () => SESSION;
    const first = nextSession(null, NOW, newId);
    expect(first).toMatchObject({ id: SESSION, isNew: true });
    const other = "11111111-2222-4333-8444-555555555555";
    const kept = nextSession(JSON.stringify({ id: other, at: NOW }), NOW + SESSION_IDLE_MS, newId);
    expect(kept).toMatchObject({ id: other, isNew: false });
    expect(JSON.parse(kept.stored)).toEqual({ id: other, at: NOW + SESSION_IDLE_MS });
    expect(nextSession(JSON.stringify({ id: other, at: NOW }), NOW + SESSION_IDLE_MS + 1, newId).isNew).toBe(true);
    expect(nextSession("{bad", NOW, newId).isNew).toBe(true);
    expect(nextSession(JSON.stringify({ id: "x", at: NOW }), NOW, newId).isNew).toBe(true);
  });
});
