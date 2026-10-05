import { describe, expect, it } from "vitest";
import { TAP_GAP_MS, createTapGate } from "../../shared/tapGate";

describe("R22 연타 막기", () => {
  it("R22: 마지막으로 받아들인 탭에서 600ms 안의 탭은 무시하고, 무시한 탭은 기준을 옮기지 않는다", () => {
    expect(TAP_GAP_MS).toBe(600);
    const gate = createTapGate();
    expect(gate(1000)).toBe(true);
    expect(gate(1001)).toBe(false);
    expect(gate(1599)).toBe(false);
    // 1599의 무시된 탭이 기준이 되지 않으므로 1600은 받는다
    expect(gate(1600)).toBe(true);
    expect(gate(2100)).toBe(false);
    expect(gate(2200)).toBe(true);
  });

  it("R22: 첫 탭은 언제든 받고, 간격은 바꿀 수 있다", () => {
    expect(createTapGate()(0)).toBe(true);
    const gate = createTapGate(100);
    expect(gate(5)).toBe(true);
    expect(gate(104)).toBe(false);
    expect(gate(105)).toBe(true);
  });

  it("R22: 탭 50번을 10ms 간격으로 연타하면(0.5초) 하나만 받는다", () => {
    const gate = createTapGate();
    const accepted = Array.from({ length: 50 }, (_, i) => gate(10_000 + i * 10)).filter(Boolean);
    expect(accepted).toHaveLength(1);
  });
});
