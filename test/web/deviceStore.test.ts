import { describe, expect, it } from "vitest";
import { SETTINGS_KEY, TIP_KEY, firstTipSeen, markFirstTipSeen, readSettingsRaw, writeSettingsRaw } from "../../web/deviceStore";

type Store = Pick<Storage, "getItem" | "setItem">;
function mem(): Store & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, String(v)) };
}
/** Safari 사생활 보호처럼 읽기는 되지만(빈 값) 쓰기는 예외 */
const readOnly = (): Store => ({ getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } });
/** 저장소 접근 자체가 막힘 */
const blocked = (): Store => ({ getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); } });

describe("R61 기기 저장소", () => {
  it("R61: 설정은 localStorage에 쓰고 읽는다 (sessionStorage는 건드리지 않는다)", () => {
    const local = mem();
    const session = mem();
    writeSettingsRaw('{"hubId":"pangyo"}', local, session);
    expect(local.data.get(SETTINGS_KEY)).toBe('{"hubId":"pangyo"}');
    expect(session.data.size).toBe(0);
    expect(readSettingsRaw(local, session)).toBe('{"hubId":"pangyo"}');
  });

  it("R61: localStorage에 쓸 수 없으면 sessionStorage에 남겨서 같은 탭에서 새로고침해도 다시 묻지 않는다", () => {
    for (const local of [readOnly(), blocked()]) {
      const session = mem();
      writeSettingsRaw('{"hubId":"ddp"}', local, session);
      expect(session.data.get(SETTINGS_KEY)).toBe('{"hubId":"ddp"}');
      expect(readSettingsRaw(local, session)).toBe('{"hubId":"ddp"}');
    }
    // 둘 다 안 되면 null (기본값으로 동작)
    expect(readSettingsRaw(blocked(), blocked())).toBeNull();
    expect(() => writeSettingsRaw("{}", blocked(), blocked())).not.toThrow();
  });

  it("R61/R39: 첫 방문 안내를 닫았는지 — 저장·읽기, 실패해도 예외 없음", () => {
    const local = mem();
    expect(firstTipSeen(local)).toBe(false);
    markFirstTipSeen(local);
    expect(local.data.get(TIP_KEY)).toBe("1");
    expect(firstTipSeen(local)).toBe(true);
    expect(firstTipSeen(blocked())).toBe(false);
    expect(() => markFirstTipSeen(blocked())).not.toThrow();
  });
});
