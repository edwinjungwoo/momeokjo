import { afterEach, describe, expect, it, vi } from "vitest";

/** IndexedDB 대역: open()마다 시나리오 하나를 꺼내 비동기로 이벤트를 쏜다 */
type Scenario = "error" | "blocked-then-success" | "success" | "broken-db";
type FakeDb = { close: ReturnType<typeof vi.fn>; transaction: (...a: unknown[]) => unknown; onclose?: unknown; onversionchange?: unknown };

function fakeIndexedDb(scenarios: Scenario[]) {
  const dbs: FakeDb[] = [];
  const makeDb = (broken: boolean): FakeDb => {
    const db: FakeDb = {
      close: vi.fn(),
      transaction: () => {
        if (broken) throw new Error("InvalidStateError");
        return {
          objectStore: () => ({
            get: () => {
              const req: { result: unknown; onsuccess?: () => void } = { result: undefined };
              setTimeout(() => req.onsuccess?.(), 0);
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
      req.result = makeDb(kind === "broken-db");
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
});
