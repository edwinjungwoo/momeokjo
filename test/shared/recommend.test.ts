import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS, drawTrio, filterPlaces, relaxNotice, relaxToFill, sortPlaces, weightOf, type Filters,
} from "../../shared/recommend";
import type { ApiPlace, CategoryGroup } from "../../shared/types";
import { apiPlace } from "../helpers/apiPlace";

const NOON_MON = new Date("2026-10-05T12:00:00+09:00");
const f = (patch: Partial<Filters> = {}): Filters => ({ ...DEFAULT_FILTERS, ...patch });
const ids = (ps: { id: string }[]) => ps.map((p) => p.id);

describe("R16 반경", () => {
  it("R16: 기본값은 반경 500m · 2명 · 영업 중만 (점심시간 프리셋 없음)", () => {
    expect(DEFAULT_FILTERS).toEqual({
      radius: 500, party: 2, groups: [], includeBar: false,
      priceCap: "all", minRating: 0, openOnly: true, sort: "distance",
    });
  });
});

describe("R18 필터", () => {
  it("R18: 반경 밖은 제외", () => {
    const ps = [apiPlace("in", { distance: 700 }), apiPlace("out", { distance: 701 })];
    expect(ids(filterPlaces(ps, f({ openOnly: false, radius: 700 }), NOON_MON))).toEqual(["in"]);
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

describe("R21′ 3곳 뽑기", () => {
  // 가중치: rating 4 → 1 × log10(90+10) = 2, rating 6 → 3 × 2 = 6
  const w2 = (id: string, group: CategoryGroup = "korean") => apiPlace(id, { group }, { rating: 4, reviewCount: 90 });
  const w6 = (id: string, group: CategoryGroup = "korean") => apiPlace(id, { group }, { rating: 6, reviewCount: 90 });
  const GROUPS: CategoryGroup[] = ["korean", "chinese", "japanese", "western", "asian"];
  const cands = (n: number) => Array.from({ length: n }, (_, i) => w2(`c${i}`, GROUPS[i % GROUPS.length]));
  /** 주어진 값을 차례로 돌려주고, 다 쓰면 처음부터 다시 */
  const seq = (...xs: number[]) => {
    let i = 0;
    return () => xs[i++ % xs.length];
  };
  const none = new Set<string>();

  it("R21′: 후보가 3곳 이상이면 서로 다른 3곳", () => {
    const r = drawTrio(cands(10), 2, none, seq(0.1, 0.5, 0.9))!;
    expect(r.places).toHaveLength(3);
    expect(new Set(ids(r.places)).size).toBe(3);
    expect(r.reset).toBe(false);
  });

  it("R21′: 첫 곳은 가중치 비율대로 뽑는다 (경계값)", () => {
    const a = w2("a"), b = w6("b", "chinese");
    expect(drawTrio([a, b], 2, none, seq(0))!.places[0].id).toBe("a");
    expect(drawTrio([a, b], 2, none, seq(0.249, 0))!.places[0].id).toBe("a");
    expect(drawTrio([a, b], 2, none, seq(0.251, 0))!.places[0].id).toBe("b");
    expect(drawTrio([a, b], 2, none, seq(0.9999, 0))!.places[0].id).toBe("b");
  });

  it("R21′: 뽑은 곳은 다음 뽑기에서 빠진다 (비복원)", () => {
    const ps = [w2("a", "korean"), w2("b", "chinese"), w2("c", "japanese")];
    expect(ids(drawTrio(ps, 2, none, seq(0))!.places)).toEqual(["a", "b", "c"]);
    expect(ids(drawTrio(ps, 2, none, seq(0.9999))!.places)).toEqual(["c", "b", "a"]);
  });

  it("R21′: 이미 뽑힌 그룹은 다음 뽑기에서 가중치 ×0.35 (다양성)", () => {
    // k1을 뽑은 뒤: k2 = 2 × 0.35 = 0.7, c1 = 2 → 합 2.7. 0.3 × 2.7 = 0.81 → c1 (보정이 없으면 0.3 × 4 = 1.2 → k2)
    const ps = [w2("k1", "korean"), w2("k2", "korean"), w2("c1", "chinese")];
    expect(ids(drawTrio(ps, 2, none, seq(0, 0.3, 0))!.places)).toEqual(["k1", "c1", "k2"]);
    // 경계: 0.25 × 2.7 = 0.675 < 0.7 → 같은 그룹도 여전히 뽑힐 수 있다 (강제가 아님)
    expect(ids(drawTrio(ps, 2, none, seq(0, 0.25, 0))!.places)).toEqual(["k1", "k2", "c1"]);
  });

  it("R21′: 그룹이 하나뿐이어도 3곳을 채운다", () => {
    const ps = [w2("a"), w2("b"), w2("c"), w2("d")];
    expect(drawTrio(ps, 2, none, seq(0.5))!.places).toHaveLength(3);
  });

  it("R21′: 다시 뽑기는 이미 보여준 곳을 빼고 뽑는다", () => {
    const shown = new Set(["c0", "c1", "c2", "c3", "c4", "c5"]);
    for (const x of [0, 0.3, 0.6, 0.9999]) {
      const r = drawTrio(cands(9), 2, shown, seq(x))!;
      expect(ids(r.places).filter((id) => shown.has(id))).toEqual([]);
      expect(r.places).toHaveLength(3);
      expect(r.reset).toBe(false);
    }
  });

  it("R21′: 남은 후보가 3곳보다 적으면 남은 곳을 먼저 쓰고 초기화해서 채운다 (같은 결과 안에 중복 없음)", () => {
    const r = drawTrio(cands(5), 2, new Set(["c0", "c1", "c2", "c3"]), seq(0))!;
    expect(r.reset).toBe(true);
    expect(r.places[0].id).toBe("c4");
    expect(r.places).toHaveLength(3);
    expect(new Set(ids(r.places)).size).toBe(3);
  });

  it("R21′: 다 보여줬으면 처음부터 다시 3곳", () => {
    const r = drawTrio(cands(3), 2, new Set(["c0", "c1", "c2"]), seq(0))!;
    expect(r).toMatchObject({ reset: true });
    expect(ids(r.places).sort()).toEqual(["c0", "c1", "c2"]);
  });

  it("R21′: 후보가 2곳이면 2곳, 1곳이면 1곳, 0곳이면 null", () => {
    expect(ids(drawTrio(cands(2), 2, none, seq(0))!.places)).toEqual(["c0", "c1"]);
    expect(ids(drawTrio(cands(1), 2, none, seq(0))!.places)).toEqual(["c0"]);
    expect(drawTrio([], 2, none, seq(0))).toBeNull();
  });

  it("R21′: 가중치가 아주 작은 후보만 있어도 3곳을 뽑는다", () => {
    const ps = ["a", "b", "c", "d"].map((id) => apiPlace(id, {}, { rating: 3, reviewCount: 0 }));
    expect(drawTrio(ps, 2, none, seq(0.7))!.places).toHaveLength(3);
  });

  it("R21′: rng가 1에 가까워도 범위를 넘지 않는다", () => {
    const r = drawTrio(cands(4), 2, none, () => 0.9999999999)!;
    expect(r.places).toHaveLength(3);
    expect(r.places.every(Boolean)).toBe(true);
  });

  it("R37: 개인화 배수를 가중치에 곱하고, 0이면 후보에서 뺀다", () => {
    const a = w2("a"), b = w6("b", "chinese");
    // a: 2 × 3 = 6, b: 6 → 반반
    const triple = { multiplier: (p: ApiPlace) => (p.id === "a" ? 3 : 1) };
    expect(drawTrio([a, b], 2, none, seq(0.49, 0), triple)!.places[0].id).toBe("a");
    expect(drawTrio([a, b], 2, none, seq(0.51, 0), triple)!.places[0].id).toBe("b");
    const hideA = { multiplier: (p: ApiPlace) => (p.id === "a" ? 0 : 1) };
    expect(ids(drawTrio([a, b], 2, none, seq(0), hideA)!.places)).toEqual(["b"]);
    expect(drawTrio([a], 2, none, seq(0), hideA)).toBeNull();
  });
});

describe("R41 부족하면 알아서 완화", () => {
  // 월요일 12시. CLOSED는 지금 닫힌 영업시간(월 18:00~22:00)
  const CLOSED = { 1: [[1080, 1320]] as [number, number][] };
  const seqR = (...xs: number[]) => {
    let i = 0;
    return () => xs[i++ % xs.length];
  };
  const none = new Set<string>();

  it("R41: 후보가 3곳 이상이면 아무것도 풀지 않는다", () => {
    const ps = ["a", "b", "c"].map((id) => apiPlace(id));
    const r = relaxToFill(ps, f(), NOON_MON);
    expect(ids(r.candidates)).toEqual(["a", "b", "c"]);
    expect(r.extra).toEqual([]);
    expect(r.relaxed).toEqual([]);
  });

  it("R41: 후보 1곳이면 평점→예산 순으로 풀어 3곳을 채운다", () => {
    const ps = [
      apiPlace("ok", {}, { rating: 4.5, price: 9000 }),
      apiPlace("lowRating", {}, { rating: 3.0, price: 9000 }),
      apiPlace("pricey", {}, { rating: 4.5, price: 18000 }),
      apiPlace("both", {}, { rating: 3.0, price: 18000 }),
    ];
    const r = relaxToFill(ps, f({ minRating: 4, priceCap: 10000 }), NOON_MON);
    expect(ids(r.candidates)).toEqual(["ok"]);
    // 평점만 풀면 2곳 → 예산까지 풀면 4곳
    expect(ids(r.extra).sort()).toEqual(["both", "lowRating", "pricey"]);
    expect(r.relaxed).toEqual(["minRating", "priceCap"]);
    expect(r.addedRadius).toBe(0);
  });

  it("R41: 앞 단계로 3곳이 차면 뒤 조건은 풀지 않는다", () => {
    const ps = [
      apiPlace("ok", {}, { rating: 4.5, price: 9000 }),
      apiPlace("r1", {}, { rating: 3.0, price: 9000 }),
      apiPlace("r2", {}, { rating: 3.2, price: 9000 }),
      apiPlace("pricey", {}, { rating: 4.5, price: 18000 }),
    ];
    const r = relaxToFill(ps, f({ minRating: 4, priceCap: 10000 }), NOON_MON);
    expect(ids(r.extra).sort()).toEqual(["r1", "r2"]);
    expect(r.relaxed).toEqual(["minRating"]);
  });

  it("R41: 영업 중 조건은 풀지 않는다", () => {
    const ps = [apiPlace("open"), apiPlace("closed1", {}, { hours: CLOSED }), apiPlace("closed2", { distance: 900 }, { hours: CLOSED })];
    const r = relaxToFill(ps, f({ minRating: 4, groups: ["chinese"], radius: 300 }), NOON_MON);
    expect(ids(r.candidates)).toEqual([]);
    expect(ids(r.extra)).toEqual(["open"]);
    expect([...r.extra, ...r.candidates].some((p) => p.id.startsWith("closed"))).toBe(false);
  });

  it("R41: 4명+ 분식 제외·술집·디저트 제외는 풀지 않는다", () => {
    const ps = [
      apiPlace("k"), apiPlace("s", { group: "snack" }), apiPlace("b", { group: "bar" }), apiPlace("d", { group: "dessert" }),
    ];
    const r = relaxToFill(ps, f({ party: 4, groups: ["chinese"] }), NOON_MON);
    expect(ids(r.extra)).toEqual(["k"]);
    expect(r.relaxed).toEqual(["groups"]);
  });

  it("R41: 마지막으로 반경을 +300m(최대 1000m) 넓힌다", () => {
    const ps = [apiPlace("in", { distance: 400 }), apiPlace("near", { distance: 650 }), apiPlace("far", { distance: 750 })];
    const r = relaxToFill(ps, f({ radius: 400 }), NOON_MON);
    expect(ids(r.extra)).toEqual(["near"]);
    expect(r.relaxed).toEqual(["radius"]);
    expect(r.addedRadius).toBe(300);
    const edge = relaxToFill([apiPlace("x", { distance: 1000 })], f({ radius: 900 }), NOON_MON);
    expect(ids(edge.extra)).toEqual(["x"]);
    expect(edge.addedRadius).toBe(100);
    expect(relaxToFill([apiPlace("x", { distance: 990 })], f({ radius: 1000 }), NOON_MON).relaxed).toEqual([]);
  });

  it("R41: 실제로 들어온 곳이 어긴 조건만 알린다", () => {
    // 평점을 풀어도 아무도 안 들어오고, 예산을 풀어야 들어온다
    const ps = [apiPlace("ok", {}, { rating: 4.5, price: 9000 }), apiPlace("pricey", {}, { rating: 4.5, price: 18000 })];
    const r = relaxToFill(ps, f({ minRating: 4, priceCap: 10000 }), NOON_MON);
    expect(ids(r.extra)).toEqual(["pricey"]);
    expect(r.relaxed).toEqual(["priceCap"]);
  });

  it("R41: 빼둔 곳(keep=false)은 원래 후보로도 완화로도 들어오지 않는다", () => {
    const ps = [apiPlace("a"), apiPlace("b", { group: "chinese" }), apiPlace("c", { group: "chinese" })];
    const r = relaxToFill(ps, f({ groups: ["korean"] }), NOON_MON, { keep: (p) => p.id !== "c" });
    expect(ids(r.candidates)).toEqual(["a"]);
    expect(ids(r.extra)).toEqual(["b"]);
  });

  it("R41: 풀어도 0곳이면 빈 결과", () => {
    const r = relaxToFill([apiPlace("closed", {}, { hours: CLOSED })], f({ minRating: 4 }), NOON_MON);
    expect(r.candidates).toEqual([]);
    expect(r.extra).toEqual([]);
    expect(r.relaxed).toEqual([]);
  });

  it("R41: 토스트 문구는 푼 조건을 한 줄로", () => {
    expect(relaxNotice([], 0)).toBeNull();
    expect(relaxNotice(["minRating"], 0)).toBe("조건에 맞는 곳이 적어서 평점 조건을 풀었어요");
    expect(relaxNotice(["minRating", "priceCap", "groups"], 0)).toBe("조건에 맞는 곳이 적어서 평점·예산·카테고리 조건을 풀었어요");
    expect(relaxNotice(["radius"], 300)).toBe("조건에 맞는 곳이 적어서 반경을 300m 넓혔어요");
    expect(relaxNotice(["priceCap", "radius"], 300)).toBe("조건에 맞는 곳이 적어서 예산 조건을 풀고 반경을 300m 넓혔어요");
  });

  it("R41: 뽑기는 원래 후보를 먼저 넣고 모자란 만큼 완화로 들어온 곳에서 채운다", () => {
    const base = [apiPlace("a")];
    const extra = ["x", "y", "z", "w"].map((id) => apiPlace(id, { group: "chinese" }));
    for (const x of [0, 0.5, 0.9999]) {
      const r = drawTrio(base, 2, none, seqR(x), { extra })!;
      expect(r.places[0].id).toBe("a");
      expect(r.places).toHaveLength(3);
      expect(r.reset).toBe(false);
    }
    // 원래 후보가 0곳이어도 완화로 들어온 곳에서 뽑는다
    expect(drawTrio([], 2, none, seqR(0), { extra })!.places).toHaveLength(3);
  });

  it("R41: 다시 뽑기는 이미 보여준 곳을 빼고, 완화 후보까지 다 돌면 초기화한다", () => {
    const base = [apiPlace("a")];
    const extra = ["x", "y", "z"].map((id) => apiPlace(id, { group: "chinese" }));
    const r = drawTrio(base, 2, new Set(["a"]), seqR(0), { extra })!;
    expect(ids(r.places).sort()).toEqual(["x", "y", "z"]);
    expect(r.reset).toBe(false);
    const r2 = drawTrio(base, 2, new Set(["a", "x", "y", "z"]), seqR(0), { extra })!;
    expect(r2.reset).toBe(true);
    expect(r2.places[0].id).toBe("a");
    expect(r2.places).toHaveLength(3);
  });
});

describe("R44 강등 모드에서도 뽑기", () => {
  it("R44: 모든 가게의 detail이 null이어도 3곳을 뽑고 다양성 보정이 그대로 작동한다", () => {
    // 상세가 없으면 가중치는 모두 0.5. k1을 뽑은 뒤 k2 = 0.175, c1 = 0.5 → 합 0.675, 0.3 × 0.675 = 0.2025 → c1
    const ps = [apiPlace("k1", {}, null), apiPlace("k2", {}, null), apiPlace("c1", { group: "chinese" }, null)];
    let i = 0;
    const xs = [0, 0.3, 0];
    const r = drawTrio(ps, 2, new Set(), () => xs[i++ % xs.length])!;
    expect(ids(r.places)).toEqual(["k1", "c1", "k2"]);
    // 필터도 상세 없는 곳을 통과시킨다 (평점·예산 조건이 꺼져 있으면)
    expect(filterPlaces(ps, f(), NOON_MON)).toHaveLength(3);
  });
});
