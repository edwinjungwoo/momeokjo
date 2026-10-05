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
});
