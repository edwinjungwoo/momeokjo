import { describe, expect, it } from "vitest";
import { ago, dayLabel, delta, duration, kstTime, num, pct, until, refreshDoneLabel, refreshStartLabel } from "../../web/admin/format";

describe("관리 화면 숫자·시간 표기", () => {
  it("R57: 1만 이상은 만 단위(소수 한 자리), 10만 이상은 정수 만, 1억 이상은 억", () => {
    expect([num(0), num(9_999), num(12_345), num(120_000), num(1_684_310), num(250_000_000)]).toEqual([
      "0", "9,999", "1.2만", "12만", "168만", "2.5억",
    ]);
    expect([num(48.63), num(null), num(Number.NaN), num(10_000)]).toEqual(["48.6", "–", "–", "1만"]);
  });

  it("R57: 비율·증감률 (1% 미만은 소수 한 자리, 0은 ±0%)", () => {
    expect([pct(0.391), pct(0.004), pct(0), pct(null)]).toEqual(["39%", "0.4%", "0%", "–"]);
    expect([delta(0.124), delta(-0.05), delta(0.001), delta(null)]).toEqual(["+12%", "−5%", "±0%", ""]);
  });

  it("R57: 시간은 KST, 길이는 초·분·시간", () => {
    expect([duration(25), duration(190), duration(3900), duration(null)]).toEqual(["25초", "3분 10초", "1시간 5분", "–"]);
    expect(kstTime(Date.UTC(2027, 0, 15, 4, 5))).toBe("1/15 13:05");
    expect(dayLabel("2027-01-15")).toBe("1/15(금)");
    const now = 1_800_000_000_000;
    expect([ago(now - 10_000, now), ago(now - 180_000, now), ago(now - 2 * 86_400_000, now)]).toEqual(["방금", "3분 전", "2일 전"]);
    expect(until(now + (3 * 3600 + 12 * 60) * 1000, now)).toBe("3시간 12분");
  });
});

describe("R63 운영 거점 표의 주간 갱신", () => {
  const KST = 9 * 3600_000;
  const start = Date.UTC(2026, 9, 5) - KST; // 10/5(월) 00:00 KST
  it("R63: 요일·이번 시작, 이번 갱신을 끝냈으면 완료 시각, 아니면 진행 중(지난 완료가 있으면 같이)", () => {
    expect(refreshStartLabel(1, start)).toBe("월 10/5");
    expect(refreshStartLabel(1, Number.NaN)).toBe("월");
    expect(refreshDoneLabel({ refreshStart: start, refreshedStart: start, refreshedAt: start + 13.5 * 3600_000 })).toEqual({
      done: true, text: "10/5 13:30",
    });
    expect(refreshDoneLabel({ refreshStart: start, refreshedStart: start - 7 * 86_400_000, refreshedAt: start - 6 * 86_400_000 })).toEqual({
      done: false, text: "진행 중 · 지난 완료 9/29 00:00",
    });
    expect(refreshDoneLabel({ refreshStart: start, refreshedStart: null, refreshedAt: null })).toEqual({ done: false, text: "진행 중" });
  });
});
