import { describe, expect, it } from "vitest";
import { representativePrice } from "../../shared/price";

const m = (...prices: number[]) => prices.map((price, i) => ({ name: `m${i}`, price }));

describe("price", () => {
  it("R7: 전골(중) 67,000원은 대표가격 계산에서 제외", () => {
    expect(representativePrice(m(14000, 16000, 16000, 67000))).toBe(16000);
  });
  it("R7: 짝수 개면 가운데 두 값의 평균", () => {
    expect(representativePrice(m(9000, 12000))).toBe(10500);
  });
  it("R7: 100원 단위 반올림", () => {
    expect(representativePrice(m(8950))).toBe(9000);
    expect(representativePrice(m(12340))).toBe(12300);
  });
  it("R7: 가운데 두 값의 평균이 50원으로 끝나면(반올림 경계) 올린다", () => {
    expect(representativePrice(m(10000, 10100))).toBe(10100); // 10,050
    expect(representativePrice(m(9900, 10000))).toBe(10000); // 9,950
    expect(representativePrice(m(12000, 12101))).toBe(12100); // 12,050.5
    expect(representativePrice(m(12000, 12099))).toBe(12000); // 12,049.5
  });

  it("R7: 범위 경계 5,000원과 30,000원은 포함", () => {
    expect(representativePrice(m(5000))).toBe(5000);
    expect(representativePrice(m(30000))).toBe(30000);
  });
  it("R7: 해당 가격이 없으면 null (-1, 0, 저가, 고가만)", () => {
    expect(representativePrice([])).toBeNull();
    expect(representativePrice(m(-1, 0, 3000, 45000))).toBeNull();
  });
});
