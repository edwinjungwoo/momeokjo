import { describe, expect, it } from "vitest";
import { RESOLVE_CONCURRENCY, forEachLimited } from "../../web/mineResolve";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("R65 내 가게 — 이름 다시 불러오기", () => {
  it("R65: 동시에 3곳까지, 순서대로 시작하고 실패는 조용히 넘긴다", async () => {
    expect(RESOLVE_CONCURRENCY).toBe(3);
    let inFlight = 0;
    let peak = 0;
    const started: string[] = [];
    const done: string[] = [];
    await forEachLimited(["1", "2", "3", "4", "5", "6", "7"], RESOLVE_CONCURRENCY, async (id) => {
      started.push(id);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
      if (id === "2") throw new Error("404");
      done.push(id);
    });
    expect(peak).toBe(3);
    expect(started).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(done.sort()).toEqual(["1", "3", "4", "5", "6", "7"]);
  });

  it("R65: 시트를 닫으면(멈춤) 새로 시작하지 않는다", async () => {
    const ctrl = new AbortController();
    const started: string[] = [];
    await forEachLimited(["1", "2", "3", "4", "5"], 2, async (id) => {
      started.push(id);
      if (id === "2") ctrl.abort();
      await tick();
    }, ctrl.signal);
    expect(started).toEqual(["1", "2"]);
  });
});
