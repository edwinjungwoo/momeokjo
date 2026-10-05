import { describe, expect, it } from "vitest";
import {
  EMPTY_PERSONAL, MAX_SIGNALS, addSignals, decay, excludePlace, groupBoost, includePlace, parsePersonal,
  personalMultiplier, recencyFactor, type PersonalState, type Signal,
} from "../../shared/personal";

const NOW = Date.parse("2026-10-05T12:00:00+09:00");
const H = 3600_000;
const D = 24 * H;
const sig = (kind: Signal["kind"], ageMs: number, id = "1", group: Signal["group"] = "korean"): Signal => ({
  id, group, kind, at: NOW - ageMs,
});
const state = (...signals: Signal[]): PersonalState => ({ signals, excluded: {} });
const place = (id = "1", group: Signal["group"] = "korean") => ({ id, group });

describe("R37 개인화 (기기 안에서만)", () => {
  it("R37: 감쇠는 3일(보여줌은 1일)에 걸쳐 1에서 0으로 직선", () => {
    expect(decay("kakao_open", 0)).toBe(1);
    expect(decay("kakao_open", 1.5 * D)).toBeCloseTo(0.5, 9);
    expect(decay("shared", 3 * D)).toBe(0);
    expect(decay("received", 4 * D)).toBe(0);
    expect(decay("shown", 12 * H)).toBeCloseTo(0.5, 9);
    expect(decay("shown", D)).toBe(0);
    // 시계가 뒤로 가서 미래 시각이면 방금 일어난 것으로 본다
    expect(decay("shown", -H)).toBe(1);
  });

  it("R37: 최근 신호 배수 = Π(1 − 강도 × 감쇠), 강도 카카오맵 0.85 · 공유 0.5 · 받음 0.5 · 보여줌 0.25", () => {
    expect(recencyFactor(state(), "1", NOW)).toBe(1);
    expect(recencyFactor(state(sig("kakao_open", 0)), "1", NOW)).toBeCloseTo(0.15, 9);
    expect(recencyFactor(state(sig("shared", 0)), "1", NOW)).toBeCloseTo(0.5, 9);
    expect(recencyFactor(state(sig("received", 0)), "1", NOW)).toBeCloseTo(0.5, 9);
    expect(recencyFactor(state(sig("shown", 0)), "1", NOW)).toBeCloseTo(0.75, 9);
    expect(recencyFactor(state(sig("shown", 12 * H)), "1", NOW)).toBeCloseTo(1 - 0.25 * 0.5, 9);
    expect(recencyFactor(state(sig("shared", 0), sig("shown", 0)), "1", NOW)).toBeCloseTo(0.375, 9);
    // 다른 가게의 신호는 상관없다
    expect(recencyFactor(state(sig("kakao_open", 0, "2")), "1", NOW)).toBe(1);
  });

  it("R37: 최근 신호 배수의 바닥은 0.05", () => {
    const s = state(sig("kakao_open", 0), sig("shared", 0), sig("received", 0), sig("shown", 0));
    expect(recencyFactor(s, "1", NOW)).toBe(0.05);
  });

  it("R37: 최근 30일 카카오맵·공유 1번마다 그 그룹 ×(1 + 0.15), 최대 1.45", () => {
    expect(groupBoost(state(), "korean", NOW)).toBe(1);
    expect(groupBoost(state(sig("kakao_open", 5 * D, "9")), "korean", NOW)).toBeCloseTo(1.15, 9);
    expect(groupBoost(state(sig("kakao_open", D, "9"), sig("shared", 2 * D, "8")), "korean", NOW)).toBeCloseTo(1.3, 9);
    const many = Array.from({ length: 5 }, (_, i) => sig("shared", i * D, `x${i}`));
    expect(groupBoost(state(...many), "korean", NOW)).toBeCloseTo(1.45, 9);
    // 보여줌·받음은 취향 신호가 아니다. 다른 그룹, 30일 지난 신호도 세지 않는다
    expect(groupBoost(state(sig("shown", 0, "9"), sig("received", 0, "9")), "korean", NOW)).toBe(1);
    expect(groupBoost(state(sig("kakao_open", 0, "9", "chinese")), "korean", NOW)).toBe(1);
    expect(groupBoost(state(sig("kakao_open", 31 * D, "9")), "korean", NOW)).toBe(1);
  });

  it("R37: 최종 배수 = 최근 신호 배수 × 그룹 가산, '여긴 빼줘'면 0", () => {
    const s = state(sig("kakao_open", 0, "1"), sig("shared", 0, "2"));
    // 1번: 0.15 × (1 + 0.15 × 2)
    expect(personalMultiplier(s, place("1"), NOW)).toBeCloseTo(0.15 * 1.3, 9);
    expect(personalMultiplier(s, place("3"), NOW)).toBeCloseTo(1.3, 9);
    expect(personalMultiplier(s, place("3", "chinese"), NOW)).toBe(1);
    const hidden = excludePlace(s, "3", NOW);
    expect(personalMultiplier(hidden, place("3"), NOW)).toBe(0);
    expect(personalMultiplier(includePlace(hidden, "3"), place("3"), NOW)).toBeCloseTo(1.3, 9);
  });

  it("R37: 빼기·되돌리기는 원래 상태를 바꾸지 않는다", () => {
    const s = excludePlace(EMPTY_PERSONAL, "7", NOW);
    expect(s.excluded).toEqual({ "7": NOW });
    expect(EMPTY_PERSONAL.excluded).toEqual({});
    expect(includePlace(s, "7").excluded).toEqual({});
    expect(s.excluded).toEqual({ "7": NOW });
  });

  it("R37: 신호를 더할 때 30일 지난 것은 버리고 최근 300개만 남긴다", () => {
    const old = sig("shown", 31 * D, "old");
    const s = addSignals(state(old, sig("shown", D, "keep")), [sig("shared", 0, "new")], NOW);
    expect(s.signals.map((x) => x.id)).toEqual(["keep", "new"]);
    const lots = Array.from({ length: MAX_SIGNALS + 5 }, (_, i) => sig("shown", (MAX_SIGNALS + 5 - i) * 60_000, `s${i}`));
    const capped = addSignals(EMPTY_PERSONAL, lots, NOW);
    expect(capped.signals).toHaveLength(MAX_SIGNALS);
    expect(capped.signals[0].id).toBe("s5");
    expect(capped.signals.at(-1)!.id).toBe(`s${MAX_SIGNALS + 4}`);
  });

  it("R37: 저장값 파싱 — 깨졌거나 모르는 값은 버린다", () => {
    expect(parsePersonal(null)).toEqual(EMPTY_PERSONAL);
    expect(parsePersonal("{not json")).toEqual(EMPTY_PERSONAL);
    expect(parsePersonal(JSON.stringify({ signals: "x", excluded: [] }))).toEqual(EMPTY_PERSONAL);
    const raw = JSON.stringify({
      signals: [
        { id: "1", group: "korean", kind: "shared", at: NOW },
        { id: "2", group: "korean", kind: "liked", at: NOW },
        { id: "abc", group: "korean", kind: "shown", at: NOW },
        { id: "3", group: "pizza", kind: "shown", at: NOW },
        { id: "4", group: "bar", kind: "kakao_open", at: "x" },
      ],
      excluded: { "5": NOW, x: NOW, "6": "y" },
    });
    expect(parsePersonal(raw)).toEqual({
      signals: [{ id: "1", group: "korean", kind: "shared", at: NOW }],
      excluded: { "5": NOW },
    });
  });
});
