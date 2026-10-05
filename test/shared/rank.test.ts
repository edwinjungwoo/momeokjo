import { describe, expect, it } from "vitest";
import { RANK_PRIOR_REVIEWS, RANK_TOP_LIMIT, topPercents } from "../../shared/rank";
import { apiPlace } from "../helpers/apiPlace";

const rated = (id: string, rating: number | null, reviewCount: number | null = 50) => apiPlace(id, {}, { rating, reviewCount });

describe("R34 근처 상위 N%", () => {
  it("R34/R51: 상위 30%까지만 표시, 순위는 리뷰 20개만큼의 지역 평균을 섞은 평점(m = 20)으로", () => {
    expect(RANK_PRIOR_REVIEWS).toBe(20);
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

  it("R51: 평점 없음·상세 없음은 대상이 아니다. 리뷰가 적거나 리뷰 수가 없으면(0개로 봄) 빼지 않고 지역 평균 쪽으로 끌어당긴다", () => {
    const ps = [
      rated("top", 4.9), rated("few", 5.0, 4), rated("norating", null), rated("nocount", 4.9, null), apiPlace("nodetail", {}, null),
      ...Array.from({ length: 9 }, (_, i) => rated(`x${i}`, 3.0 - i * 0.1)),
    ];
    const m = topPercents(ps);
    // 대상은 평점이 있는 12곳, C = 38.2 / 12 ≈ 3.18
    // top (50×4.9 + 20C)/70 ≈ 4.41 > few (4×5.0 + 20C)/24 ≈ 3.49 > nocount = C ≈ 3.18 > x0 (50×3.0 + 20C)/70 ≈ 3.05
    expect([...m.entries()]).toEqual([["top", 9], ["few", 17], ["nocount", 25]]);
  });

  it("R51: 리뷰 6개짜리 5.0은 리뷰 300개짜리 4.6보다 아래 (보이는 별점은 그대로라 순위만 바뀐다)", () => {
    const ps = [
      rated("five", 5.0, 6), rated("solid", 4.6, 300),
      ...Array.from({ length: 8 }, (_, i) => rated(`x${i}`, 4.0, 100)),
    ];
    const m = topPercents(ps);
    expect(m.get("solid")).toBe(10);
    expect(m.get("five")).toBe(20);
    expect(ps[0].detail?.rating).toBe(5.0);
  });

  it("R51: 같은 평점·같은 리뷰 수는 같은 점수라 더 좋은 순위를 함께 쓰고, 평점이 같아도 리뷰가 많은 쪽이 위", () => {
    const ps = [rated("a", 4.5, 200), rated("b", 4.5, 200), rated("c", 4.5, 10), ...Array.from({ length: 7 }, (_, i) => rated(`x${i}`, 3.5, 50))];
    const m = topPercents(ps);
    expect(m.get("a")).toBe(10);
    expect(m.get("b")).toBe(10);
    expect(m.get("c")).toBe(30);
  });

  it("R34: 1% 미만이어도 최소 1%, 대상이 하나뿐이면(100%) 없음", () => {
    const many = [rated("best", 5.0), ...Array.from({ length: 299 }, (_, i) => rated(`x${i}`, 3.0))];
    expect(topPercents(many).get("best")).toBe(1);
    expect(topPercents([rated("only", 5.0)]).size).toBe(0);
    expect(topPercents([]).size).toBe(0);
  });

  it("R42: 거점의 1000m 목록을 받아도 순위는 화면 반경 안의 가게끼리 매긴다", () => {
    const near = Array.from({ length: 4 }, (_, i) => apiPlace(`n${i}`, { distance: 100 + i }, { rating: 4.0 - i * 0.1, reviewCount: 50 }));
    const far = Array.from({ length: 6 }, (_, i) => apiPlace(`f${i}`, { distance: 800 }, { rating: 4.9, reviewCount: 50 }));
    const all = [...near, ...far];
    // 1000m 전체로 매기면 가까운 곳은 30% 밖
    expect(topPercents(all).has("n0")).toBe(false);
    // 반경 500m 안에서만 매기면 n0이 1위(4곳 중 1위 = 25%)
    const m = topPercents(all, 500);
    expect(m.get("n0")).toBe(25);
    expect(m.has("f0")).toBe(false);
    expect(m.size).toBe(1);
  });
});
