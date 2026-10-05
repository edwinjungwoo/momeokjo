import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "mmj:seen:v1";

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

const load = async () => import("../../web/seen");

describe("R46 본 곳 기억 (localStorage mmj:seen:v1)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("R46: 보여준 곳을 기억해 저장하고, 다음에 열면 저장본에서 읽는다 (30일 지난 곳은 버림)", async () => {
    const now = Date.now();
    const old = now - 31 * 24 * 3600_000;
    const storage = memoryStorage({ [KEY]: JSON.stringify({ 1: now - 1000, 2: old, x: now }) });
    vi.stubGlobal("localStorage", storage);
    const seen = await load();
    expect(seen.seenSnapshot()).toEqual({ 1: now - 1000 });
    const before = seen.seenSnapshot();
    seen.recordSeen(["3", "1"]);
    const after = seen.seenSnapshot();
    expect(Object.keys(after).sort()).toEqual(["1", "3"]);
    expect(after["1"]).toBeGreaterThanOrEqual(now);
    // 앞서 받은 스냅숏은 바뀌지 않는다 (결과를 띄우기 전 기억으로 쓴다)
    expect(before).toEqual({ 1: now - 1000 });
    expect(JSON.parse(storage.raw.get(KEY)!)).toEqual(after);

    vi.resetModules();
    const again = await load();
    expect(again.seenSnapshot()).toEqual(after);
  });

  it("R46: 저장소를 읽거나 쓸 수 없으면 조용히 이번 세션 메모리에만 둔다", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    const seen = await load();
    expect(seen.seenSnapshot()).toEqual({});
    expect(() => seen.recordSeen(["5"])).not.toThrow();
    expect(Object.keys(seen.seenSnapshot())).toEqual(["5"]);
  });

  it("R46: localStorage가 아예 없는 환경에서도 던지지 않는다", async () => {
    vi.stubGlobal("localStorage", undefined);
    const seen = await load();
    expect(seen.seenSnapshot()).toEqual({});
    expect(() => seen.recordSeen(["7"])).not.toThrow();
    expect(Object.keys(seen.seenSnapshot())).toEqual(["7"]);
    expect(() => seen.recordSeen([])).not.toThrow();
  });
});
