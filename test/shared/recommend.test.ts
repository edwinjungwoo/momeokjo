import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS, draw, filterPlaces, sortPlaces, weightOf, withLunch, withRadius, type Filters,
} from "../../shared/recommend";
import { apiPlace } from "../helpers/apiPlace";

const NOON_MON = new Date("2026-10-05T12:00:00+09:00");
const f = (patch: Partial<Filters> = {}): Filters => ({ ...DEFAULT_FILTERS, ...patch });
const ids = (ps: { id: string }[]) => ps.map((p) => p.id);

describe("R16 점심시간 → 반경", () => {
  it("R16: 30/60/90분은 300/700/1200m", () => {
    expect(withLunch(f(), 30).radius).toBe(300);
    expect(withLunch(f(), 60).radius).toBe(700);
    expect(withLunch(f(), 90)).toMatchObject({ lunch: 90, radius: 1200 });
  });
  it("R16: 반경을 직접 바꾸면 점심시간 선택이 해제된다", () => {
    expect(withRadius(f(), 850)).toMatchObject({ lunch: null, radius: 850 });
  });
  it("R16: 기본값은 60분 · 700m · 2명 · 영업 중만", () => {
    expect(DEFAULT_FILTERS).toEqual({
      lunch: 60, radius: 700, party: 2, groups: [], includeBar: false,
      priceCap: "all", minRating: 0, openOnly: true, sort: "distance",
    });
  });
});

describe("R18 필터", () => {
  it("R18: 반경 밖은 제외", () => {
    const ps = [apiPlace("in", { distance: 700 }), apiPlace("out", { distance: 701 })];
    expect(ids(filterPlaces(ps, f({ openOnly: false }), NOON_MON))).toEqual(["in"]);
  });

  it("R18: 카테고리를 고르지 않으면 전체(술집 제외), 고르면 해당 그룹만", () => {
    const ps = [
      apiPlace("k"), apiPlace("c", { group: "chinese" }), apiPlace("b", { group: "bar" }), apiPlace("d", { group: "dessert" }),
    ];
    expect(ids(filterPlaces(ps, f({ openOnly: false }), NOON_MON))).toEqual(["k", "c"]);
    expect(ids(filterPlaces(ps, f({ openOnly: false, groups: ["chinese"] }), NOON_MON))).toEqual(["c"]);
  });

  it("R18: 술집 포함을 켜면 술집도 들어온다", () => {
    const ps = [apiPlace("k"), apiPlace("b", { group: "bar" })];
    expect(ids(filterPlaces(ps, f({ openOnly: false, includeBar: true }), NOON_MON))).toEqual(["k", "b"]);
  });

  it("R18: 예산 필터 — 가격 정보가 없으면 제외", () => {
    const ps = [
      apiPlace("cheap", {}, { price: 9000 }), apiPlace("mid", {}, { price: 15000 }),
      apiPlace("none", {}, { price: null }), apiPlace("nodetail", {}, null),
    ];
    expect(ids(filterPlaces(ps, f({ openOnly: false, priceCap: 15000 }), NOON_MON))).toEqual(["cheap", "mid"]);
    expect(ids(filterPlaces(ps, f({ openOnly: false }), NOON_MON))).toEqual(["cheap", "mid", "none", "nodetail"]);
  });

  it("R18: 최소 평점 — 평점 정보가 없으면 제외", () => {
    const ps = [apiPlace("a", {}, { rating: 4.2 }), apiPlace("b", {}, { rating: 3.4 }), apiPlace("c", {}, { rating: null })];
    expect(ids(filterPlaces(ps, f({ openOnly: false, minRating: 3.5 }), NOON_MON))).toEqual(["a"]);
  });

  it("R17/R18: 영업 중만 — 닫힌 곳은 빼고 정보 없는 곳은 통과", () => {
    const ps = [
      apiPlace("open", {}, { hours: { 1: [[660, 1320]] } }),
      apiPlace("closed", {}, { hours: { 1: [[1020, 1320]] } }),
      apiPlace("unknown", {}, { hours: null }),
    ];
    expect(ids(filterPlaces(ps, f(), NOON_MON))).toEqual(["open", "unknown"]);
  });

  it("R19: 4명 이상이면 분식·패스트푸드 제외", () => {
    const ps = [apiPlace("k"), apiPlace("s", { group: "snack" })];
    expect(ids(filterPlaces(ps, f({ openOnly: false, party: 4 }), NOON_MON))).toEqual(["k"]);
    expect(ids(filterPlaces(ps, f({ openOnly: false, party: 3 }), NOON_MON))).toEqual(["k", "s"]);
  });
});

describe("R20 정렬", () => {
  const ps = [
    apiPlace("a", { distance: 300 }, { rating: 3.9, price: 15000 }),
    apiPlace("b", { distance: 100 }, { rating: null, price: null }),
    apiPlace("c", { distance: 200 }, { rating: 4.5, price: 9000 }),
  ];
  it("R20: 거리순", () => expect(ids(sortPlaces(ps, "distance"))).toEqual(["b", "c", "a"]));
  it("R20: 평점순 (null은 맨 뒤)", () => expect(ids(sortPlaces(ps, "rating"))).toEqual(["c", "a", "b"]));
  it("R20: 가격순 (null은 맨 뒤)", () => expect(ids(sortPlaces(ps, "price"))).toEqual(["c", "a", "b"]));
  it("R20: 원본 배열은 바꾸지 않는다", () => {
    sortPlaces(ps, "rating");
    expect(ids(ps)).toEqual(["a", "b", "c"]);
  });
});

describe("R19/R21 가중치", () => {
  it("R21: base = max(0.3, rating − 3) × log10(reviewCount + 10)", () => {
    expect(weightOf(apiPlace("a", {}, { rating: 4.1, reviewCount: 814 }), 2)).toBeCloseTo(1.1 * Math.log10(824), 6);
    expect(weightOf(apiPlace("a", {}, { rating: 3.0, reviewCount: 90 }), 2)).toBeCloseTo(0.3 * 2, 6);
  });
  it("R21: 평점이 없으면 0.5", () => {
    expect(weightOf(apiPlace("a", {}, { rating: null }), 2)).toBe(0.5);
    expect(weightOf(apiPlace("a", {}, null), 2)).toBe(0.5);
  });
  it("R19: 1명이면 혼밥 친화(서버가 계산한 soloFriendly) ×1.5", () => {
    const base = weightOf(apiPlace("a"), 1);
    expect(weightOf(apiPlace("a", {}, { soloFriendly: true }), 1)).toBeCloseTo(base * 1.5, 6);
    expect(weightOf(apiPlace("a", {}, { soloFriendly: true }), 2)).toBeCloseTo(base, 6);
    expect(weightOf(apiPlace("a", {}, null), 1)).toBe(0.5);
  });
  it("R19: 4명 이상이면 단체 친화(groupFriendly) ×1.3, 예약 가능 추가 ×1.3", () => {
    const base = weightOf(apiPlace("a"), 4);
    expect(weightOf(apiPlace("a", {}, { groupFriendly: true }), 4)).toBeCloseTo(base * 1.3, 6);
    expect(weightOf(apiPlace("a", {}, { bookable: true }), 4)).toBeCloseTo(base * 1.3, 6);
    expect(weightOf(apiPlace("a", {}, { groupFriendly: true, bookable: true }), 4)).toBeCloseTo(base * 1.69, 6);
    expect(weightOf(apiPlace("a", {}, { groupFriendly: true, bookable: true }), 3)).toBeCloseTo(base, 6);
  });
});

describe("R21 뽑기", () => {
  // 가중치 1 : 3 이 되도록 구성 (rating 4 → 1 × log10(90+10)=2, rating 6 → 3 × 2 = 6)
  const a = apiPlace("a", {}, { rating: 4, reviewCount: 90 });
  const b = apiPlace("b", {}, { rating: 6, reviewCount: 90 });

  it("R21: 가중치 비율대로 뽑힌다 (경계값)", () => {
    expect(draw([a, b], 2, new Set(), () => 0)!.place.id).toBe("a");
    expect(draw([a, b], 2, new Set(), () => 0.249)!.place.id).toBe("a");
    expect(draw([a, b], 2, new Set(), () => 0.251)!.place.id).toBe("b");
    expect(draw([a, b], 2, new Set(), () => 0.9999)!.place.id).toBe("b");
  });

  it("R21: 이미 뽑힌 곳은 제외한다", () => {
    expect(draw([a, b], 2, new Set(["b"]), () => 0.9)).toEqual({ place: a, reset: false });
  });

  it("R21: 다 뽑았으면 제외 목록을 비우고 다시 시작한다", () => {
    expect(draw([a, b], 2, new Set(["a", "b"]), () => 0)).toEqual({ place: a, reset: true });
  });

  it("R21: 후보가 없으면 null", () => {
    expect(draw([], 2, new Set(), () => 0)).toBeNull();
  });
});
