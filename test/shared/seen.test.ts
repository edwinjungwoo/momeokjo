import { describe, expect, it } from "vitest";
import { MAX_SEEN, SEEN_TTL_MS, isNew, markSeen, mergeSeen, parseSeen, pruneSeen, type Seen } from "../../shared/seen";

const NOW = Date.parse("2026-10-06T12:00:00+09:00");
const D = 24 * 3600_000;

describe("R46 이 기기에서 본 곳 (seen)", () => {
  it("R46: 30일 동안, 최대 500곳까지 기억한다", () => {
    expect(SEEN_TTL_MS).toBe(30 * D);
    expect(MAX_SEEN).toBe(500);
  });

  it("R46: markSeen은 보여준 곳마다 마지막으로 본 시각을 남긴다 (다시 보면 시각만 새로)", () => {
    const a = markSeen({}, ["1", "2"], NOW - D);
    expect(a).toEqual({ 1: NOW - D, 2: NOW - D });
    const b = markSeen(a, ["2", "3"], NOW);
    expect(b).toEqual({ 1: NOW - D, 2: NOW, 3: NOW });
    // 원래 객체는 바꾸지 않는다 (결과를 띄우기 전 스냅숏으로 쓴다)
    expect(a).toEqual({ 1: NOW - D, 2: NOW - D });
    expect(markSeen(a, [], NOW)).toEqual(a);
  });

  it("R46: isNew는 기억에 없는 곳만 참", () => {
    const s = markSeen({}, ["1"], NOW);
    expect(isNew(s, "1")).toBe(false);
    expect(isNew(s, "2")).toBe(true);
    expect(isNew({}, "1")).toBe(true);
  });

  it("R46: pruneSeen은 30일 지난 곳을 버리고, 시계가 어긋난 미래 시각은 지금 본 것으로 낮춘다 (영영 남거나 늘 가장 최근이 되지 않게)", () => {
    const s: Seen = { 1: NOW - 30 * D, 2: NOW - 30 * D - 1, 3: NOW + D, 5: NOW + 3650 * D };
    expect(pruneSeen(s, NOW)).toEqual({ 1: NOW - 30 * D, 3: NOW, 5: NOW });
    // markSeen도 같은 정리를 한다
    expect(markSeen(s, ["4"], NOW)).toEqual({ 1: NOW - 30 * D, 3: NOW, 4: NOW, 5: NOW });
    // 낮춘 곳도 30일 뒤에는 잊는다
    expect(pruneSeen(pruneSeen(s, NOW), NOW + 30 * D + 1)).toEqual({});
  });

  it("R46: mergeSeen은 두 기억(이 탭·다른 탭이 저장한 것)을 합쳐 곳마다 더 늦게 본 시각을 남긴다 (정리 규칙 그대로)", () => {
    const mine: Seen = { 1: NOW - D, 2: NOW };
    const stored: Seen = { 1: NOW, 3: NOW - 2 * D, 4: NOW - 31 * D };
    expect(mergeSeen(mine, stored, NOW)).toEqual({ 1: NOW, 2: NOW, 3: NOW - 2 * D });
    expect(mergeSeen({}, {}, NOW)).toEqual({});
    // 원래 객체는 바꾸지 않는다
    expect(mine).toEqual({ 1: NOW - D, 2: NOW });
  });

  it("R46: 500곳을 넘으면 가장 오래전에 본 곳부터 버린다", () => {
    const full: Record<string, number> = {};
    for (let i = 0; i < MAX_SEEN; i++) full[String(1000 + i)] = NOW - D + i;
    const s = markSeen(full, ["1", "2"], NOW);
    expect(Object.keys(s)).toHaveLength(MAX_SEEN);
    expect(s["1"]).toBe(NOW);
    expect(s["2"]).toBe(NOW);
    expect("1000" in s).toBe(false);
    expect("1001" in s).toBe(false);
    expect(s["1002"]).toBe(NOW - D + 2);
  });

  it("R46: parseSeen은 깨진 값을 버리고 올바른 항목(숫자 id 1~15자리 → 유한한 시각)만 남긴다", () => {
    expect(parseSeen(null)).toEqual({});
    expect(parseSeen("")).toEqual({});
    expect(parseSeen("{")).toEqual({});
    expect(parseSeen("[1,2]")).toEqual({});
    expect(parseSeen("null")).toEqual({});
    expect(parseSeen(JSON.stringify({ 1: NOW, abc: NOW, 2: "x", 3: null, "1234567890123456": NOW, 4: NOW - D }))).toEqual({
      1: NOW, 4: NOW - D,
    });
  });
});
