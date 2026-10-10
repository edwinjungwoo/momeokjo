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

  it("R46: 쓸 때 저장본을 다시 읽어 합친다 — 다른 탭이 그사이 기억한 곳을 덮어 지우지 않는다", async () => {
    const now = Date.now();
    const storage = memoryStorage({ [KEY]: JSON.stringify({ 1: now - 1000 }) });
    vi.stubGlobal("localStorage", storage);
    const seen = await load();
    expect(seen.seenSnapshot()).toEqual({ 1: now - 1000 });
    // 다른 탭이 2를 기억해 저장했다
    storage.setItem(KEY, JSON.stringify({ 1: now - 1000, 2: now - 500 }));
    seen.recordSeen(["3"]);
    const saved = JSON.parse(storage.raw.get(KEY)!);
    expect(Object.keys(saved).sort()).toEqual(["1", "2", "3"]);
    expect(saved["2"]).toBe(now - 500);
    // 이 탭의 기억도 다른 탭이 본 곳을 안다 (처음 보는 곳 판단이 글자 그대로 참이게)
    expect(Object.keys(seen.seenSnapshot()).sort()).toEqual(["1", "2", "3"]);
  });

  it("R46: 쓰기 직전에 저장본을 읽지 못하면 쓰지 않는다 — 이번 세션 기억만으로 저장된 기억을 덮지 않게", async () => {
    const now = Date.now();
    const storage = memoryStorage({ [KEY]: JSON.stringify({ 1: now - 1000, 2: now - 900 }) });
    let readable = true;
    const writes: string[] = [];
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => {
        if (!readable) throw new Error("SecurityError");
        return storage.getItem(k);
      },
      setItem: (k: string, v: string) => {
        writes.push(v);
        storage.setItem(k, v);
      },
    });
    const seen = await load();
    expect(Object.keys(seen.seenSnapshot()).sort()).toEqual(["1", "2"]);
    readable = false;
    seen.recordSeen(["3"]);
    expect(writes).toEqual([]);
    expect(Object.keys(seen.seenSnapshot()).sort()).toEqual(["1", "2", "3"]);
    // 다시 읽을 수 있게 되면 합쳐서 쓴다
    readable = true;
    seen.recordSeen(["4"]);
    expect(Object.keys(JSON.parse(storage.raw.get(KEY)!)).sort()).toEqual(["1", "2", "3", "4"]);
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
