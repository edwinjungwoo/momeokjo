import { describe, expect, it } from "vitest";
import { BACKFILL_LIMIT_MAX, on5xx, parseBackfillArgs, SERVER_ERROR_LIMIT, SERVER_ERROR_WAIT_MS } from "../../scripts/backfillGuard.mjs";

const HUBS = ["ddp", "bongeunsa"];

describe("R12: backfill.mjs의 5xx 처리", () => {
  it("R12: 5xx는 3초 기다렸다 다시 하고, 연속 3번째에서 멈춘다", () => {
    expect(SERVER_ERROR_LIMIT).toBe(3);
    expect(SERVER_ERROR_WAIT_MS).toBe(3000);
    expect(on5xx(1)).toEqual({ action: "retry", waitMs: 3000 });
    expect(on5xx(2)).toEqual({ action: "retry", waitMs: 3000 });
    expect(on5xx(3)).toEqual({ action: "stop" });
    expect(on5xx(4)).toEqual({ action: "stop" });
  });
});

describe("R12: backfill.mjs의 인자 해석", () => {
  it("R12: 인자가 없으면 모든 거점, --hub와 --limit는 순서 무관하게 받는다", () => {
    expect(parseBackfillArgs([], HUBS)).toEqual({ ok: true, hub: undefined, limit: undefined });
    expect(parseBackfillArgs(["--hub", "ddp"], HUBS)).toEqual({ ok: true, hub: "ddp", limit: undefined });
    expect(parseBackfillArgs(["--limit", "200"], HUBS)).toEqual({ ok: true, hub: undefined, limit: 200 });
    expect(parseBackfillArgs(["--limit", "1", "--hub", "bongeunsa"], HUBS)).toEqual({ ok: true, hub: "bongeunsa", limit: 1 });
    expect(parseBackfillArgs(["--hub", "ddp", "--limit", String(BACKFILL_LIMIT_MAX)], HUBS)).toEqual({ ok: true, hub: "ddp", limit: 300 });
  });

  it("R12: --limit은 1~300 정수만 — 0·301·음수·소수·글자·빈 값은 오류", () => {
    expect(BACKFILL_LIMIT_MAX).toBe(300);
    for (const bad of ["0", "301", "-1", "1.5", "abc", "", "1e2", " 5"]) {
      expect(parseBackfillArgs(["--limit", bad], HUBS), bad).toMatchObject({ ok: false });
    }
    expect(parseBackfillArgs(["--limit"], HUBS)).toMatchObject({ ok: false });
  });

  it("R12: 모르는 거점·모르는 인자·같은 플래그 두 번은 오류", () => {
    expect(parseBackfillArgs(["--hub", "nowhere"], HUBS)).toMatchObject({ ok: false, error: expect.stringContaining("ddp, bongeunsa") });
    expect(parseBackfillArgs(["--hub"], HUBS)).toMatchObject({ ok: false });
    expect(parseBackfillArgs(["ddp"], HUBS)).toMatchObject({ ok: false });
    expect(parseBackfillArgs(["--hub", "ddp", "--hub", "bongeunsa"], HUBS)).toMatchObject({ ok: false });
    expect(parseBackfillArgs(["--limit", "5", "--limit", "6"], HUBS)).toMatchObject({ ok: false });
  });
});
