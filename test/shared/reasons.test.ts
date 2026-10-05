import { describe, expect, it } from "vitest";
import { NEW_PLACE_MIN_SEEN, priceBand, trioReasons } from "../../shared/reasons";
import { markSeen, type Seen } from "../../shared/seen";
import type { ApiPlace } from "../../shared/types";
import { apiPlace } from "../helpers/apiPlace";

const NOW = 1_800_000_000_000;
const place = (id: string, walkMinutes: number | undefined, rating: number | null, price: number | null = null): ApiPlace =>
  apiPlace(id, { walkMinutes }, { rating, price });
/** 이 기기에서 본 곳: ids + 다른 곳 n개 (결과를 띄우기 전 기록) */
const seenOf = (ids: string[], n: number): Seen =>
  markSeen({}, [...ids, ...Array.from({ length: n }, (_, i) => `9${i}`)], NOW - 3600_000);
const none = { seen: {} as Seen };

describe("R46 3곳에 \"왜\" 한 단어", () => {
  it("R46: 가장 가까운 곳(도보 분이 혼자 가장 작음)에 \"제일 가까워요\"", () => {
    expect(trioReasons([place("1", 3, null), place("2", 7, null), place("3", 9, null)], none)).toEqual([
      "제일 가까워요", null, null,
    ]);
  });

  it("R46: 평점이 혼자 가장 높고 4.0 이상이면 \"평점 최고\" (4.0 미만이면 없음)", () => {
    expect(trioReasons([place("1", 5, 3.9), place("2", 5, 4.2), place("3", 5, 4.1)], none)).toEqual([null, "평점 최고", null]);
    expect(trioReasons([place("1", 5, 3.9), place("2", 5, 3.8), place("3", 5, 3.5)], none)).toEqual([null, null, null]);
  });

  it("R46: 가격대가 혼자 가장 낮고 평점 3.8 이상이면 \"가성비\" — 가격을 아는 곳이 2곳 이상일 때만", () => {
    // 가격대: 1만 이하 / 1.5만 이하 / 2만 이하 / 그 위
    expect([9000, 10000, 10100, 15000, 20000, 25000].map(priceBand)).toEqual([0, 0, 1, 1, 2, 3]);
    expect(trioReasons([place("1", 5, 3.8, 9000), place("2", 5, 3.8, 12000), place("3", 5, 3.8, null)], none)).toEqual([
      "가성비", null, null,
    ]);
    // 평점이 3.8보다 낮거나 없으면 가성비라고 하지 않는다
    expect(trioReasons([place("1", 5, 3.7, 9000), place("2", 5, 3.8, 12000), place("3", 5, 3.8, 18000)], none)).toEqual([null, null, null]);
    expect(trioReasons([place("1", 5, null, 9000), place("2", 5, 3.8, 12000), place("3", 5, 3.8, 18000)], none)).toEqual([null, null, null]);
    // 가격을 아는 곳이 1곳뿐이면 비교할 수 없다
    expect(trioReasons([place("1", 5, 3.9, 9000), place("2", 5, 3.8, null), place("3", 5, 3.8, null)], none)).toEqual([null, null, null]);
    // 같은 가격대(9,000원과 10,000원은 둘 다 1만 이하)는 동점
    expect(trioReasons([place("1", 5, 3.9, 9000), place("2", 5, 3.8, 10000), place("3", 5, 3.8, 18000)], none)).toEqual([null, null, null]);
  });

  it("R46: 이 기기에서 본 곳이 15곳 이상일 때, 본 적 없는 곳이 혼자면 \"처음 보는 곳\"", () => {
    const ps = [place("1", 5, null), place("2", 5, null), place("3", 5, null)];
    expect(NEW_PLACE_MIN_SEEN).toBe(15);
    expect(trioReasons(ps, { seen: seenOf(["1", "2"], 13) })).toEqual([null, null, "처음 보는 곳"]);
    // 본 곳이 14곳뿐이면 (처음 쓰는 사람에겐 다 처음이라) 붙이지 않는다
    expect(trioReasons(ps, { seen: seenOf(["1", "2"], 12) })).toEqual([null, null, null]);
    // 처음 보는 곳이 2곳 이상이면 동점이라 붙이지 않는다
    expect(trioReasons(ps, { seen: seenOf(["1"], 14) })).toEqual([null, null, null]);
    // 셋 다 본 곳이면 없음
    expect(trioReasons(ps, { seen: seenOf(["1", "2", "3"], 12) })).toEqual([null, null, null]);
  });

  it("R46: 개인화 신호(R37)가 아니라 본 곳 기억으로만 판단한다 — 30일 안에 한 번이라도 보여준 곳은 처음이 아니다", () => {
    const ps = [place("1", 5, null), place("2", 5, null), place("3", 5, null)];
    // 3번을 29일 전에 한 번 보여줬다 (shown 신호는 하루면 사라지지만 본 곳 기억은 남는다)
    const seen = markSeen(seenOf(["1", "2"], 13), ["3"], NOW - 29 * 24 * 3600_000);
    expect(trioReasons(ps, { seen })).toEqual([null, null, null]);
  });

  it("R46: 결과를 띄우기 전의 기억으로 판단한다 — 이번 결과를 기록한 뒤의 기억을 넘기면 \"처음 보는 곳\"이 사라진다", () => {
    const ps = [place("1", 5, null), place("2", 5, null), place("3", 5, null)];
    const before = seenOf(["1", "2"], 13);
    const after = markSeen(before, ["1", "2", "3"], NOW);
    expect(trioReasons(ps, { seen: before })).toEqual([null, null, "처음 보는 곳"]);
    expect(trioReasons(ps, { seen: after })).toEqual([null, null, null]);
  });

  it("R46: \"조건 밖\"(R41) 카드에는 이유를 붙이지 않는다 — 표시는 카드당 하나. 다른 카드의 이유는 그대로(넘겨주지 않는다)", () => {
    const ps = [place("1", 3, 4.6, 9000), place("2", 6, 4.2, 12000), place("3", 8, 4.0, 18000)];
    // 1번이 제일 가깝지만 조건 밖 → 1번은 없음, "제일 가까워요"를 2번에 넘기지 않는다 (2번은 제일 가깝지 않으니까)
    expect(trioReasons(ps, { seen: {}, outside: new Set(["1"]) })).toEqual([null, null, null]);
    const ps2 = [place("1", 3, 3.9, 16000), place("2", 6, 4.6, 18000), place("3", 8, 3.9, 9000)];
    expect(trioReasons(ps2, { seen: {} })).toEqual(["제일 가까워요", "평점 최고", "가성비"]);
    expect(trioReasons(ps2, { seen: {}, outside: new Set(["2"]) })).toEqual(["제일 가까워요", null, "가성비"]);
    expect(trioReasons(ps2, { seen: {}, outside: new Set(["1", "2", "3"]) })).toEqual([null, null, null]);
  });

  it("R46: 동점이면 붙이지 않는다 (같은 도보 분, 같은 평점)", () => {
    expect(trioReasons([place("1", 4, 4.5), place("2", 4, 4.5), place("3", 9, 4.0)], none)).toEqual([null, null, null]);
  });

  it("R46: 카드당 최대 하나, 같은 말을 두 카드에 붙이지 않는다 — 앞 순서(가까움 → 평점 → 가성비 → 처음)가 먼저", () => {
    // 1번이 가장 가깝고 평점도 가장 높다 → 1번은 "제일 가까워요"만, "평점 최고"는 다른 카드에 넘기지 않는다
    const r1 = trioReasons([place("1", 3, 4.6, 9000), place("2", 6, 4.2, 12000), place("3", 8, 4.0, 18000)], none);
    expect(r1).toEqual(["제일 가까워요", null, null]);
    // 셋이 각각 다른 이유
    const ps = [place("1", 3, 3.9, 16000), place("2", 6, 4.6, 18000), place("3", 8, 3.9, 9000)];
    const r2 = trioReasons(ps, { seen: seenOf(["1", "2"], 13) });
    expect(r2).toEqual(["제일 가까워요", "평점 최고", "가성비"]);
    for (const r of [r1, r2]) {
      const labels = r.filter((x) => x !== null);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });

  it("R46: 1곳뿐이면 비교할 게 없어서 붙이지 않고, 도보 분을 모르는 곳이 있으면 \"제일 가까워요\"라고 하지 않는다", () => {
    expect(trioReasons([place("1", 3, 4.9, 9000)], { seen: seenOf([], 20) })).toEqual([null]);
    expect(trioReasons([], none)).toEqual([]);
    expect(trioReasons([place("1", 3, null), place("2", undefined, null), place("3", 9, null)], none)).toEqual([null, null, null]);
    // 2곳이면 2곳 중에서
    expect(trioReasons([place("1", 3, 4.1), place("2", 5, 4.4)], none)).toEqual(["제일 가까워요", "평점 최고"]);
  });
});
