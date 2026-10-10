import { describe, expect, it } from "vitest";
import { mapLimit } from "../../worker/pool";

const tick = (ms = 1) => new Promise<void>((r) => setTimeout(r, ms));

describe("mapLimit", () => {
  it("infra: 모든 항목을 한 번씩, 동시에 limit개까지만 처리한다", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      done.push(n);
      active -= 1;
    });
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
  });

  it("infra: 항목이 limit보다 적으면 그만큼만 동시에, 비었으면 fn을 부르지 않고 끝난다", async () => {
    let peak = 0;
    let active = 0;
    await mapLimit([1, 2], 5, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    });
    expect(peak).toBe(2);
    let calls = 0;
    await mapLimit([], 3, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it("infra: 하나가 실패하면 새 항목을 시작하지 않고, 이미 시작한 항목이 끝난 뒤에 첫 오류로 거부한다 (부른 쪽 몰래 도는 작업이 남지 않는다)", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = mapLimit([1, 2, 3, 4, 5, 6], 3, async (n) => {
      started.push(n);
      if (n === 1) throw new Error("boom");
      await gate;
      finished.push(n);
    });
    let settled = false;
    p.catch(() => {}).finally(() => (settled = true));
    await tick(5);
    // 2·3은 아직 도는 중 — 끝나기 전에 거부하지 않는다
    expect(settled).toBe(false);
    release();
    await expect(p).rejects.toThrow("boom");
    expect(started).toEqual([1, 2, 3]);
    expect(finished.sort((a, b) => a - b)).toEqual([2, 3]);
  });
});
