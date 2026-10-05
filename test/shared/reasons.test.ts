import { describe, expect, it } from "vitest";
import type { Signal } from "../../shared/personal";
import { NEW_PLACE_MIN_SIGNALS, priceBand, trioReasons } from "../../shared/reasons";
import type { ApiPlace } from "../../shared/types";
import { apiPlace } from "../helpers/apiPlace";

const NOW = 1_800_000_000_000;
const place = (id: string, walkMinutes: number | undefined, rating: number | null, price: number | null = null): ApiPlace =>
  apiPlace(id, { walkMinutes }, { rating, price });
const sig = (id: string, at = NOW - 3600_000): Signal => ({ id, group: "korean", kind: "shown", at });
const others = (n: number, at = NOW - 3600_000) => Array.from({ length: n }, (_, i) => sig(`9${i}`, at));
const none = { signals: [] as Signal[] };

describe("R46 3곳에 \"왜\" 한 단어", () => {
  it("R46: 가장 가까운 곳(도보 분이 혼자 가장 작음)에 \"제일 가까워요\"", () => {
    expect(trioReasons([place("1", 3, null), place("2", 7, null), place("3", 9, null)], NOW, none)).toEqual([
      "제일 가까워요", null, null,
    ]);
  });

  it("R46: 평점이 혼자 가장 높고 4.0 이상이면 \"평점 최고\" (4.0 미만이면 없음)", () => {
    expect(trioReasons([place("1", 5, 3.9), place("2", 5, 4.2), place("3", 5, 4.1)], NOW, none)).toEqual([null, "평점 최고", null]);
    expect(trioReasons([place("1", 5, 3.9), place("2", 5, 3.8), place("3", 5, 3.5)], NOW, none)).toEqual([null, null, null]);
  });

  it("R46: 가격대가 혼자 가장 낮고 평점 3.8 이상이면 \"가성비\" — 가격을 아는 곳이 2곳 이상일 때만", () => {
    // 가격대: 1만 이하 / 1.5만 이하 / 2만 이하 / 그 위
    expect([9000, 10000, 10100, 15000, 20000, 25000].map(priceBand)).toEqual([0, 0, 1, 1, 2, 3]);
    expect(trioReasons([place("1", 5, 3.8, 9000), place("2", 5, 3.8, 12000), place("3", 5, 3.8, null)], NOW, none)).toEqual([
      "가성비", null, null,
    ]);
    // 평점이 3.8보다 낮거나 없으면 가성비라고 하지 않는다
    expect(trioReasons([place("1", 5, 3.7, 9000), place("2", 5, 3.8, 12000), place("3", 5, 3.8, 18000)], NOW, none)).toEqual([null, null, null]);
    expect(trioReasons([place("1", 5, null, 9000), place("2", 5, 3.8, 12000), place("3", 5, 3.8, 18000)], NOW, none)).toEqual([null, null, null]);
    // 가격을 아는 곳이 1곳뿐이면 비교할 수 없다
    expect(trioReasons([place("1", 5, 3.9, 9000), place("2", 5, 3.8, null), place("3", 5, 3.8, null)], NOW, none)).toEqual([null, null, null]);
    // 같은 가격대(9,000원과 10,000원은 둘 다 1만 이하)는 동점
    expect(trioReasons([place("1", 5, 3.9, 9000), place("2", 5, 3.8, 10000), place("3", 5, 3.8, 18000)], NOW, none)).toEqual([null, null, null]);
  });

  it("R46: 신호가 5개 이상인 사람에게, 이 가게 신호가 하나도 없는 곳이 혼자면 \"처음 보는 곳\"", () => {
    const ps = [place("1", 5, null), place("2", 5, null), place("3", 5, null)];
    expect(NEW_PLACE_MIN_SIGNALS).toBe(5);
    const seen = [sig("1"), sig("2"), ...others(3)];
    expect(trioReasons(ps, NOW, { signals: seen })).toEqual([null, null, "처음 보는 곳"]);
    // 신호가 4개뿐이면 (처음 쓰는 사람에겐 다 처음이라) 붙이지 않는다
    expect(trioReasons(ps, NOW, { signals: [sig("1"), sig("2"), ...others(2)] })).toEqual([null, null, null]);
    // 처음 보는 곳이 2곳 이상이면 동점이라 붙이지 않는다
    expect(trioReasons(ps, NOW, { signals: [sig("1"), ...others(4)] })).toEqual([null, null, null]);
  });

  it("R46: now(결과를 띄운 시각) 이후의 신호는 보지 않는다 — 이번 결과로 남긴 shown이 \"처음 보는 곳\"을 지우지 않게", () => {
    const ps = [place("1", 5, null), place("2", 5, null), place("3", 5, null)];
    const before = [sig("1"), sig("2"), ...others(3)];
    const after = [sig("1", NOW), sig("2", NOW), sig("3", NOW), sig("3", NOW + 1000), ...others(5, NOW + 1)];
    expect(trioReasons(ps, NOW, { signals: [...before, ...after] })).toEqual([null, null, "처음 보는 곳"]);
  });

  it("R46: 동점이면 붙이지 않는다 (같은 도보 분, 같은 평점)", () => {
    expect(trioReasons([place("1", 4, 4.5), place("2", 4, 4.5), place("3", 9, 4.0)], NOW, none)).toEqual([null, null, null]);
  });

  it("R46: 카드당 최대 하나, 같은 말을 두 카드에 붙이지 않는다 — 앞 순서(가까움 → 평점 → 가성비 → 처음)가 먼저", () => {
    // 1번이 가장 가깝고 평점도 가장 높다 → 1번은 "제일 가까워요"만, "평점 최고"는 다른 카드에 넘기지 않는다
    const r1 = trioReasons([place("1", 3, 4.6, 9000), place("2", 6, 4.2, 12000), place("3", 8, 4.0, 18000)], NOW, none);
    expect(r1).toEqual(["제일 가까워요", null, null]);
    // 셋이 각각 다른 이유
    const ps = [place("1", 3, 3.9, 16000), place("2", 6, 4.6, 18000), place("3", 8, 3.9, 9000)];
    const r2 = trioReasons(ps, NOW, { signals: [sig("1"), sig("2"), ...others(3)] });
    expect(r2).toEqual(["제일 가까워요", "평점 최고", "가성비"]);
    for (const r of [r1, r2]) {
      const labels = r.filter((x) => x !== null);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("R46: 1곳뿐이면 비교할 게 없어서 붙이지 않고, 도보 분을 모르는 곳이 있으면 \"제일 가까워요\"라고 하지 않는다", () => {
    expect(trioReasons([place("1", 3, 4.9, 9000)], NOW, { signals: others(9) })).toEqual([null]);
    expect(trioReasons([], NOW, none)).toEqual([]);
    expect(trioReasons([place("1", 3, null), place("2", undefined, null), place("3", 9, null)], NOW, none)).toEqual([null, null, null]);
    // 2곳이면 2곳 중에서
    expect(trioReasons([place("1", 3, 4.1), place("2", 5, 4.4)], NOW, none)).toEqual(["제일 가까워요", "평점 최고"]);
  });
});
