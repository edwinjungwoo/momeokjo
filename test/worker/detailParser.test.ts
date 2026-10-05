import { describe, expect, it } from "vitest";
import { parseDetail } from "../../worker/detailParser";
import jungang from "../fixtures/place-detail/27531028-jungang-haejang.json";
import haidilao from "../fixtures/place-detail/576159166-haidilao.json";
import hadongkwan from "../fixtures/place-detail/26428654-hadongkwan.json";
import matsugaze from "../fixtures/place-detail/12101050-matsugaze.json";
import outback from "../fixtures/place-detail/12445953-outback.json";

const ok = (raw: unknown) => {
  const r = parseDetail(raw);
  if (!r.ok) throw new Error("expected ok");
  return r.detail;
};

describe("parseDetail", () => {
  it("R6: 중앙해장 — 평점, 리뷰 수, 대표 가격, 강점, 예약, 영업시간", () => {
    const d = ok(jungang);
    expect(d.rating).toBe(4.1);
    expect(d.reviewCount).toBe(814);
    expect(d.price).toBe(16000);
    expect(d.strengths).toEqual(["맛", "친절"]);
    expect(d.bookable).toBe(false);
    expect(d.hours?.[1]).toEqual([[660, 1440]]);
    expect(d.menus).toHaveLength(6);
    expect(d.menus.every((m) => m.price > 0)).toBe(true);
  });

  it("R6: 하이디라오 — '예약가능'이면 bookable true, 가격 미표기(-1, 0)는 메뉴에서 빠지고 대표 가격 null", () => {
    const d = ok(haidilao);
    expect(d.bookable).toBe(true);
    expect(d.menus).toEqual([]);
    expect(d.price).toBeNull();
    expect(d.tags).toContain("단체석");
  });

  it("R6: 하동관 — tags에 '혼밥'이 들어온다", () => {
    const d = ok(hadongkwan);
    expect(d.tags).toContain("혼밥");
    expect(d.rating).toBe(3.3);
  });

  it("R6: 강점 개수가 같으면 원래 순서를 유지한다 (마쯔가제)", () => {
    expect(ok(matsugaze).strengths).toEqual(["친절", "분위기"]);
  });

  it("R6: 메뉴는 최대 20개, 대표 가격은 전체 메뉴로 계산한다 (아웃백)", () => {
    const d = ok(outback);
    expect(d.menus).toHaveLength(20);
    expect(d.price).toBe(22900);
  });

  it("R6: tags는 중복 없이 최대 30개", () => {
    const d = ok(haidilao);
    expect(new Set(d.tags).size).toBe(d.tags.length);
    expect(d.tags.length).toBeLessThanOrEqual(30);
  });

  it("R6: 리뷰가 0개면 rating null", () => {
    const d = ok({ summary: { name: "x" }, kakaomap_review: { score_set: { review_count: 0, average_score: 0 } } });
    expect(d.rating).toBeNull();
    expect(d.reviewCount).toBe(0);
  });

  it("R6: place_add_info가 없으면 bookable null, tags []", () => {
    const d = ok({ summary: { name: "x" } });
    expect(d.bookable).toBeNull();
    expect(d.tags).toEqual([]);
    expect(d.hours).toBeNull();
    expect(d.rating).toBeNull();
  });

  it("R6: 한 섹션이 깨져도 나머지는 살린다", () => {
    const d = ok({ ...(jungang as object), menu: "garbage", open_hours: { week_from_today: 3 } });
    expect(d.menus).toEqual([]);
    expect(d.price).toBeNull();
    expect(d.hours).toBeNull();
    expect(d.rating).toBe(4.1);
  });

  it("R6: 객체가 아니거나 알려진 키가 하나도 없으면 schema 실패", () => {
    expect(parseDetail(null)).toEqual({ ok: false, reason: "schema" });
    expect(parseDetail("x")).toEqual({ ok: false, reason: "schema" });
    expect(parseDetail([])).toEqual({ ok: false, reason: "schema" });
    expect(parseDetail({ foo: 1 })).toEqual({ ok: false, reason: "schema" });
  });
});
