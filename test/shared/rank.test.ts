import { describe, expect, it } from "vitest";
import { RANK_MIN_REVIEWS, RANK_TOP_LIMIT, topPercents } from "../../shared/rank";
import { apiPlace } from "../helpers/apiPlace";

const rated = (id: string, rating: number | null, reviewCount: number | null = 50) => apiPlace(id, {}, { rating, reviewCount });

describe("R34 근처 상위 N%", () => {
  it("R34: 기준은 리뷰 5개 이상, 상위 30%까지만 표시", () => {
    expect(RANK_MIN_REVIEWS).toBe(5);
    expect(RANK_TOP_LIMIT).toBe(30);
  });

  it("R34: 평점 순위/대상 수를 백분율로 올림 — 30% 넘으면 없음", () => {
    const ps = Array.from({ length: 10 }, (_, i) => rated(`p${i}`, 4.9 - i * 0.1));
    const m = topPercents(ps);
    expect(m.get("p0")).toBe(10);
    expect(m.get("p1")).toBe(20);
    expect(m.get("p2")).toBe(30);
    expect(m.has("p3")).toBe(false);
    expect(m.size).toBe(3);
  });

  it("R34: 같은 평점은 더 좋은 순위를 함께 쓴다", () => {
    const ps = [rated("a", 4.5), rated("b", 4.5), rated("c", 4.3), ...Array.from({ length: 7 }, (_, i) => rated(`x${i}`, 4.0))];
    const m = topPercents(ps);
    expect(m.get("a")).toBe(10);
    expect(m.get("b")).toBe(10);
    expect(m.get("c")).toBe(30);
    expect(m.has("x0")).toBe(false);
  });

  it("R34: 리뷰 5개 미만, 평점 없음, 상세 없음은 표시하지 않고 대상 수에도 넣지 않는다", () => {
    const ps = [
      rated("top", 4.9), rated("few", 5.0, 4), rated("norating", null), rated("nocount", 4.9, null), apiPlace("nodetail", {}, null),
      ...Array.from({ length: 9 }, (_, i) => rated(`x${i}`, 3.0 - i * 0.1)),
    ];
    const m = topPercents(ps);
    // 대상은 top + x0~x8 = 10곳
    expect(m.get("top")).toBe(10);
    expect([...m.entries()]).toEqual([["top", 10], ["x0", 20], ["x1", 30]]);
  });

  it("R34: 1% 미만이어도 최소 1%, 대상이 하나뿐이면(100%) 없음", () => {
    const many = [rated("best", 5.0), ...Array.from({ length: 299 }, (_, i) => rated(`x${i}`, 3.0))];
    expect(topPercents(many).get("best")).toBe(1);
    expect(topPercents([rated("only", 5.0)]).size).toBe(0);
    expect(topPercents([]).size).toBe(0);
  });
});
