import { describe, expect, it } from "vitest";
import { on429, RATE_LIMIT_RETRIES, RATE_LIMIT_WAIT_MS } from "../../scripts/warmRetry.mjs";

describe("R36: warm.mjs의 429 처리", () => {
  it("R36: rate_limited(ADMIN_LIMITER)면 30초 기다렸다 다시 하고, 연속 3번까지만", () => {
    const body = JSON.stringify({ error: "rate_limited" });
    expect(RATE_LIMIT_WAIT_MS).toBe(30_000);
    expect(RATE_LIMIT_RETRIES).toBe(3);
    expect(on429(body, 0)).toEqual({ action: "retry", waitMs: 30_000 });
    expect(on429(body, 2)).toEqual({ action: "retry", waitMs: 30_000 });
    expect(on429(body, 3)).toEqual({ action: "stop", reason: "rate_limited" });
  });

  it("R38: read_budget(오늘 D1 읽기 예산 소진)이나 알 수 없는 429는 바로 멈춘다", () => {
    expect(on429(JSON.stringify({ error: "read_budget" }), 0)).toEqual({ action: "stop", reason: "read_budget" });
    expect(on429("not json", 0)).toEqual({ action: "stop", reason: "unknown" });
    expect(on429(JSON.stringify({ error: "other" }), 0)).toEqual({ action: "stop", reason: "unknown" });
  });

  it("R38: write_budget(오늘 D1 쓰기 예산 소진, backfill.mjs)도 바로 멈춘다", () => {
    expect(on429(JSON.stringify({ error: "write_budget" }), 0)).toEqual({ action: "stop", reason: "write_budget" });
  });
});

describe("warm.mjs: 후보 고르기가 쪽 상한에서 멈춘 응답", () => {
  it("R31: truncated인데 아무것도 못 한(enriched·failed 0) 응답이 TRUNCATED_STOP_AFTER(3)번 이어지면 멈춘다 — 하나라도 하면 다시 센다", async () => {
    const { TRUNCATED_STOP_AFTER, nextTruncatedStreak } = await import("../../scripts/warmRetry.mjs");
    expect(TRUNCATED_STOP_AFTER).toBe(3);
    const stuck = { truncated: true, enriched: 0, failed: 0 };
    let streak = 0;
    for (let i = 0; i < 3; i++) streak = nextTruncatedStreak(stuck, streak);
    expect(streak).toBe(3);
    expect(nextTruncatedStreak({ truncated: true, enriched: 1, failed: 0 }, 2)).toBe(0);
    expect(nextTruncatedStreak({ truncated: true, enriched: 0, failed: 1 }, 2)).toBe(0);
    expect(nextTruncatedStreak({ truncated: false, enriched: 0, failed: 0 }, 2)).toBe(0);
    // 예전 서버(필드 없음)는 truncated가 아니다
    expect(nextTruncatedStreak({ enriched: 0, failed: 0 }, 2)).toBe(0);
    // 아직 격자를 모으는 중(incompleteTiles > 0)이면 나아가고 있으니 세지 않는다
    expect(nextTruncatedStreak({ truncated: true, enriched: 0, failed: 0, incompleteTiles: 3 }, 2)).toBe(0);
    expect(nextTruncatedStreak({ truncated: true, enriched: 0, failed: 0, incompleteTiles: 0 }, 2)).toBe(3);
  });
});

describe("warm.mjs: 호출마다 한 줄", () => {
  it("R31: 응답 한 줄에 격자·남은 수·보충·글자 수와 함께 저장 오류(enrichError)도 찍는다 (Task 34 리뷰)", async () => {
    const { warmLine } = await import("../../scripts/warmRetry.mjs");
    const r = { incompleteTiles: 0, pending: "more", enriched: 3, failed: 1, deferred: 2, chars: 180000 };
    expect(warmLine(4, r)).toBe("#4 incompleteTiles=0 pending=more enriched=3 failed=1 deferred=2 chars=180000");
    expect(warmLine(5, { ...r, truncated: true, enrichError: true })).toBe(
      "#5 incompleteTiles=0 pending=more enriched=3 failed=1 deferred=2 chars=180000 truncated enrichError",
    );
    // 예전 서버(필드 없음)
    expect(warmLine(1, { incompleteTiles: 2, pending: 0, enriched: 0, failed: 0 })).toBe(
      "#1 incompleteTiles=2 pending=0 enriched=0 failed=0 deferred=0 chars=0",
    );
  });
});
