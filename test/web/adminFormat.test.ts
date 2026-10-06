import { describe, expect, it } from "vitest";
import { ago, dayLabel, delta, duration, kstTime, num, pct, until } from "../../web/admin/format";

describe("관리 화면 숫자·시간 표기", () => {
  it("R52: 1만 이상은 만 단위(소수 한 자리), 10만 이상은 정수 만, 1억 이상은 억", () => {
    expect([num(0), num(9_999), num(12_345), num(120_000), num(1_684_310), num(250_000_000)]).toEqual([
      "0", "9,999", "1.2만", "12만", "168만", "2.5억",
    ]);
    expect([num(48.63), num(null), num(Number.NaN), num(10_000)]).toEqual(["48.6", "–", "–", "1만"]);
  });

  it("R52: 비율·증감률 (1% 미만은 소수 한 자리, 0은 ±0%)", () => {
    expect([pct(0.391), pct(0.004), pct(0), pct(null)]).toEqual(["39%", "0.4%", "0%", "–"]);
    expect([delta(0.124), delta(-0.05), delta(0.001), delta(null)]).toEqual(["+12%", "−5%", "±0%", ""]);
  });

  it("R52: 시간은 KST, 길이는 초·분·시간", () => {
    expect([duration(25), duration(190), duration(3900), duration(null)]).toEqual(["25초", "3분 10초", "1시간 5분", "–"]);
    expect(kstTime(Date.UTC(2027, 0, 15, 4, 5))).toBe("1/15 13:05");
    expect(dayLabel("2027-01-15")).toBe("1/15(금)");
    const now = 1_800_000_000_000;
    expect([ago(now - 10_000, now), ago(now - 180_000, now), ago(now - 2 * 86_400_000, now)]).toEqual(["방금", "3분 전", "2일 전"]);
    expect(until(now + (3 * 3600 + 12 * 60) * 1000, now)).toBe("3시간 12분");
  });
});
