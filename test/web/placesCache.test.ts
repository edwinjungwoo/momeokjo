import { afterEach, describe, expect, it, vi } from "vitest";

/** IndexedDB 대역: open()마다 시나리오 하나를 꺼내 비동기로 이벤트를 쏜다 */
type Scenario = "error" | "blocked-then-success" | "success" | "broken-db" | "slow-fail-db";
type FakeDb = { close: ReturnType<typeof vi.fn>; transaction: (...a: unknown[]) => unknown; onclose?: () => void; onversionchange?: unknown };

function fakeIndexedDb(scenarios: Scenario[]) {
  const dbs: FakeDb[] = [];
  const makeDb = (broken: boolean, slowFail = false): FakeDb => {
    const db: FakeDb = {
      close: vi.fn(),
      transaction: () => {
        if (broken) throw new Error("InvalidStateError");
        return {
          objectStore: () => ({
            get: () => {
              const req: { result: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void } = { result: undefined };
              // slowFail: 읽기가 한참 뒤에 실패한다
              if (slowFail) setTimeout(() => ((req.error = new Error("AbortError")), req.onerror?.()), 30);
              else setTimeout(() => req.onsuccess?.(), 0);
              return req;
            },
          }),
        };
      },
    };
    dbs.push(db);
    return db;
  };
  const open = vi.fn(() => {
    const kind = scenarios.shift() ?? "success";
    const req: Record<string, any> = {};
    setTimeout(() => {
      if (kind === "error") return req.onerror?.();
      if (kind === "blocked-then-success") {
        req.onblocked?.();
        req.result = makeDb(false);
        return setTimeout(() => req.onsuccess?.(), 0);
      }
      req.result = makeDb(kind === "broken-db", kind === "slow-fail-db");
      req.onsuccess?.();
    }, 0);
    return req;
  });
  return { open, dbs };
}

async function load(scenarios: Scenario[]) {
  const fake = fakeIndexedDb(scenarios);
  vi.stubGlobal("indexedDB", { open: fake.open });
  vi.resetModules();
  const mod = await import("../../web/placesCache");
  return { ...fake, mod };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("R56 저장본 ETag (작은 키)", () => {
  function fakeStorage(throwing = false) {
    const m = new Map<string, string>();
    const guard = () => {
      if (throwing) throw new Error("SecurityError");
    };
    return {
      m,
      getItem: (k: string) => (guard(), m.get(k) ?? null),
      setItem: (k: string, v: string) => (guard(), void m.set(k, v)),
      removeItem: (k: string) => (guard(), void m.delete(k)),
    };
  }

  it("R56: 거점마다 ETag만 localStorage에 따로 두고 바로(동기) 읽는다 — 이상한 값·없는 값은 null", async () => {
    const ls = fakeStorage();
    vi.stubGlobal("localStorage", ls);
    const { mod } = await load([]);
    expect(mod.readCachedEtag("ddp")).toBeNull();
    mod.writeCachedEtag("ddp", 'W/"1-ddp-abc"');
    expect(mod.readCachedEtag("ddp")).toBe('W/"1-ddp-abc"');
    expect(mod.readCachedEtag("pangyo")).toBeNull();
    mod.writeCachedEtag("ddp", null);
    expect(mod.readCachedEtag("ddp")).toBeNull();
    ls.m.set("mmj-places-etag:ddp", "x".repeat(300));
    expect(mod.readCachedEtag("ddp")).toBeNull();
  });

  it("R56: localStorage를 못 쓰면(사생활 보호 모드) 조용히 null", async () => {
    vi.stubGlobal("localStorage", fakeStorage(true));
    const { mod } = await load([]);
    expect(() => mod.writeCachedEtag("ddp", 'W/"x"')).not.toThrow();
    expect(mod.readCachedEtag("ddp")).toBeNull();
  });
});

describe("R45 기기 저장본 — 저장소 열기 실패", () => {
  it("R45: 열기가 한 번 실패(onerror)해도 다음 호출은 다시 연다 (새로고침 전까지 꺼지지 않는다)", async () => {
    const { open, mod } = await load(["error", "success"]);
    expect(await mod.readCachedPlaces("bongeunsa")).toBeNull();
    expect(await mod.readCachedPlaces("bongeunsa")).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("R45: 다른 탭 때문에 막힌(onblocked) 열기는 실패로 치고 다시 열며, 늦게 열린 연결은 닫는다", async () => {
    const { open, dbs, mod } = await load(["blocked-then-success", "success"]);
    expect(await mod.readCachedPlaces("bongeunsa")).toBeNull();
    await tick();
    expect(dbs[0].close).toHaveBeenCalledTimes(1);
    await mod.readCachedPlaces("bongeunsa");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("R45: 연 뒤 읽기·저장이 실패하면 그 연결을 닫고 다음 호출은 새로 연다", async () => {
    const { open, dbs, mod } = await load(["broken-db", "broken-db", "success"]);
    expect(await mod.readCachedPlaces("bongeunsa")).toBeNull();
    expect(dbs[0].close).toHaveBeenCalledTimes(1);
    await mod.saveCachedPlaces("bongeunsa", "{}");
    expect(dbs[1].close).toHaveBeenCalledTimes(1);
    expect(await mod.readCachedPlaces("bongeunsa")).toBeNull();
    expect(open).toHaveBeenCalledTimes(3);
    expect(dbs[2].close).not.toHaveBeenCalled();
  });

  it("R45: 옛 연결의 늦은 읽기 실패가 그 사이 새로 연 연결을 버리지 않는다 (dbPromise === p일 때만 비움)", async () => {
    const { open, dbs, mod } = await load(["slow-fail-db", "success"]);
    const slow = mod.readCachedPlaces("bongeunsa");
    await tick();
    // 그 사이 WebKit이 옛 연결을 끊어서 다음 호출이 새로 연다
    dbs[0].onclose?.();
    expect(await mod.readCachedPlaces("bongeunsa")).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
    // 옛 연결의 읽기가 이제야 실패한다
    expect(await slow).toBeNull();
    await mod.readCachedPlaces("bongeunsa");
    expect(open).toHaveBeenCalledTimes(2);
    expect(dbs[1].close).not.toHaveBeenCalled();
  });
});

describe("R45/§3.1 지난 저장본 지우기", () => {
  it("R45/§3.1: 읽은 저장본이 3일 넘었으면 쓰지 않고 그 저장본과 ETag 키를 지운다 (쓰지 않는 카카오 표시 정보를 기기에 남기지 않는다)", async () => {
    const DAY = 24 * 3600_000;
    const store = new Map<string, unknown>([
      ["ddp", { v: 1, hub: "ddp", savedAt: Date.now() - 3 * DAY - 60_000, text: '{"places":[]}', etag: '"e1"' }],
      ["pangyo", { v: 1, hub: "pangyo", savedAt: Date.now() - 2 * DAY, text: '{"places":[]}', etag: '"e2"' }],
    ]);
    const etags = new Map([["mmj-places-etag:ddp", '"e1"'], ["mmj-places-etag:pangyo", '"e2"']]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => etags.get(k) ?? null,
      setItem: (k: string, v: string) => void etags.set(k, v),
      removeItem: (k: string) => void etags.delete(k),
    });
    const request = (run: () => unknown) => {
      const req: { result: unknown; onsuccess?: () => void; onerror?: () => void } = { result: undefined };
      setTimeout(() => ((req.result = run()), req.onsuccess?.()), 0);
      return req;
    };
    const db = {
      close: vi.fn(),
      transaction: () => ({
        objectStore: () => ({ get: (k: string) => request(() => store.get(k)), delete: (k: string) => request(() => void store.delete(k)) }),
      }),
    };
    vi.stubGlobal("indexedDB", {
      open: () => {
        const req: Record<string, any> = {};
        setTimeout(() => ((req.result = db), req.onsuccess?.()), 0);
        return req;
      },
    });
    vi.resetModules();
    const mod = await import("../../web/placesCache");
    expect(await mod.readCachedPlaces("ddp")).toBeNull();
    expect(store.has("ddp")).toBe(false);
    expect(etags.has("mmj-places-etag:ddp")).toBe(false);
    // 3일 안의 저장본은 그대로 쓴다
    expect(await mod.readCachedPlaces("pangyo")).toMatchObject({ etag: '"e2"', fresh: false });
    expect(store.has("pangyo")).toBe(true);
    expect(etags.get("mmj-places-etag:pangyo")).toBe('"e2"');
  });
});
