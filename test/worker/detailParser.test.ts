import { describe, expect, it } from "vitest";
import { parseDetail } from "../../worker/detailParser";
import parserSource from "../../worker/detailParser.ts?raw";
import { parseDetailZod } from "../helpers/detailParserZod";
import jungang from "../fixtures/place-detail/27531028-jungang-haejang.json";
import haidilao from "../fixtures/place-detail/576159166-haidilao.json";
import hadongkwan from "../fixtures/place-detail/26428654-hadongkwan.json";
import matsugaze from "../fixtures/place-detail/12101050-matsugaze.json";
import outback from "../fixtures/place-detail/12445953-outback.json";

const SUMMARY = { name: "x", point: { lat: 37.5, lon: 127.05 } };

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

  it("R6: tags 상한 — 서로 다른 라벨이 40개(중복·빈 라벨 섞임)여도 처음 나온 순서대로 30개만", () => {
    const labels = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const contents = labels.flatMap((label, i) => (i % 5 === 0 ? [{ label }, { label }, { label: "" }] : [{ label }]));
    const d = ok({
      summary: SUMMARY,
      place_add_info: { full_detail_infos: [{ items: [{ contents: contents.slice(0, 20) }] }, { items: [{ contents: contents.slice(20) }] }] },
    });
    expect(d.tags).toEqual(labels.slice(0, 30));
  });

  it("R6: '예약가능'이 ai_mate 아이콘에만 있어도 bookable true, 둘 다 없으면 false", () => {
    expect(ok({ summary: SUMMARY, place_add_info: { ai_mate: { store_facility_icons: [{ text: "주차" }, { text: "예약가능" }] } } }).bookable).toBe(true);
    expect(ok({ summary: SUMMARY, place_add_info: { store_facility_icons: [{ text: "주차" }], ai_mate: { store_facility_icons: [{ text: "포장" }] } } }).bookable).toBe(false);
    expect(ok({ summary: SUMMARY, place_add_info: { ai_mate: null } }).bookable).toBe(false);
  });

  it("R6: 리뷰가 0개면 rating null", () => {
    const d = ok({ summary: SUMMARY, kakaomap_review: { score_set: { review_count: 0, average_score: 0 } } });
    expect(d.rating).toBeNull();
    expect(d.reviewCount).toBe(0);
  });

  it("R6: place_add_info가 없으면 bookable null, tags []", () => {
    const d = ok({ summary: SUMMARY });
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

  it("R6: 요약에서 이름, 카테고리 원문, 좌표, 주소, 전화를 가져온다 (중앙해장)", () => {
    const r = parseDetail(jungang);
    if (!r.ok) throw new Error("expected ok");
    expect(r.summary).toEqual({
      name: "중앙해장",
      categoryName: "음식점 > 한식 > 해장국",
      lat: 37.50827359718396,
      lng: 127.06547254091939,
      address: "서울 강남구 영동대로86길 17 육인빌딩 1층",
      phone: "02-558-7905",
      photoUrl: "https://t1.kakaocdn.net/fiy_reboot/place/B6D1BA174D394DEDB42B4411705FFDE7",
    });
  });

  it("R6: 요약에 이름이나 좌표가 없으면 표시할 수 없으므로 schema 실패", () => {
    expect(parseDetail({ summary: { name: "x" } })).toEqual({ ok: false, reason: "schema" });
    expect(parseDetail({ summary: { point: { lat: 37.5, lon: 127 } } })).toEqual({ ok: false, reason: "schema" });
    expect(parseDetail({ kakaomap_review: {} })).toEqual({ ok: false, reason: "schema" });
  });

  it("R6: 카테고리 3단계가 없으면 2단계까지만", async () => {
    const bulia = (await import("../fixtures/place-detail/1528769880-bulia.json")).default;
    const r = parseDetail(bulia);
    expect(r.ok && r.summary.categoryName).toBe("음식점 > 중식");
  });

  it("R33: 대표 사진이 외부 차단 호스트(네이버 블로그)면 photoUrl null", async () => {
    const chicken = (await import("../fixtures/place-detail/63388502-samsung-chicken.json")).default;
    const r = parseDetail(chicken);
    expect(r.ok && r.summary.photoUrl).toBeNull();
  });
});

/** 픽스처 12곳 (원문 그대로) */
const FIXTURES = Object.entries(import.meta.glob("../fixtures/place-detail/*.json", { eager: true, import: "default" }))
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([, v]) => v as Record<string, unknown>);
/** 해석이 보는 섹션 */
const SECTIONS = ["summary", "kakaomap_review", "menu", "open_hours", "place_add_info"];

/** 결정적 의사 난수 (같은 시드 = 같은 변형) */
function rng(seed: number) {
  let x = seed >>> 0;
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000);
}
type Path = (string | number)[];
/** 섹션 안의 모든 경로 (배열은 앞 4개 원소만 — 경로 수를 줄인다) */
function paths(v: unknown, at: Path, out: Path[]) {
  out.push(at);
  if (Array.isArray(v)) v.slice(0, 4).forEach((x, i) => paths(x, [...at, i], out));
  else if (typeof v === "object" && v !== null) for (const [k, x] of Object.entries(v)) paths(x, [...at, k], out);
}
const WEIRD: unknown[] = [null, undefined, "", "x", "12", 0, -1, 1.5, true, [], {}, [1], [{}], { a: 1 }];
/** 경로 하나를 바꾼다: 지우기·이상한 값·배열에 이상한 원소 끼우기 */
function mutate(root: Record<string, unknown>, path: Path, r: () => number) {
  if (path.length === 0) return;
  let parent: unknown = root;
  for (const k of path.slice(0, -1)) {
    parent = (parent as Record<string | number, unknown>)[k];
    // 앞선 변형이 길을 바꿨으면 이번 변형은 건너뛴다
    if (typeof parent !== "object" || parent === null) return;
  }
  const last = path[path.length - 1];
  const obj = parent as Record<string | number, unknown>;
  const pick = r();
  if (pick < 0.2 && !Array.isArray(obj)) delete obj[last];
  else if (pick < 0.3 && Array.isArray(obj[last])) (obj[last] as unknown[]).splice(Math.floor(r() * 3), 0, WEIRD[Math.floor(r() * WEIRD.length)]);
  else obj[last] = WEIRD[Math.floor(r() * WEIRD.length)];
}

describe("parseDetail — zod 없는 해석 (Task 57)", () => {
  it("R6: 상세 해석은 zod를 쓰지 않는다 — 새 isolate의 Cron에서 zod 스키마 검사가 상세 한 곳마다 ~0.3ms(로컬 workerd)로 해석 CPU의 절반이었다", () => {
    expect(parserSource).not.toMatch(/from "zod"/);
  });

  it("R6: 픽스처 12곳 원문은 예전 zod 해석과 같은 값", () => {
    expect(FIXTURES).toHaveLength(12);
    for (const f of FIXTURES) expect(parseDetail(f)).toEqual(parseDetailZod(f));
  });

  it("R6: 섹션 안의 값을 하나·둘씩 지우거나 이상한 값(null·빈 문자열·숫자 문자열·배열·객체 등)으로 바꾼 변형 3천여 개도 예전 zod 해석과 같은 값 — 섹션은 통째로 살거나 null, 요약이 깨지면 schema", () => {
    const r = rng(57);
    let n = 0;
    let failedSchema = 0;
    let nulled = 0;
    for (const f of FIXTURES) {
      const all: Path[] = [];
      for (const s of SECTIONS) if (s in f) paths(f[s], [s], all);
      for (let k = 0; k < 260; k++) {
        const v = structuredClone(f);
        const times = 1 + Math.floor(r() * 2);
        for (let t = 0; t < times; t++) mutate(v, all[Math.floor(r() * all.length)], r);
        const want = parseDetailZod(v);
        expect(parseDetail(v), JSON.stringify(all.length)).toEqual(want);
        n++;
        if (!want.ok) failedSchema++;
        else if (want.detail.menus.length === 0 || want.detail.hours === null || want.detail.rating === null) nulled++;
      }
    }
    // 변형이 실제로 여러 갈래(요약 실패·섹션 null)를 지난다
    expect(n).toBe(12 * 260);
    expect(failedSchema).toBeGreaterThan(50);
    expect(nulled).toBeGreaterThan(200);
  });

  it("R6: 섹션 최상위가 이상한 값이거나 요약 필드 타입이 틀린 경우도 예전과 같다", () => {
    const base = FIXTURES[0];
    for (const s of SECTIONS) {
      for (const w of WEIRD) {
        const v = { ...base, [s]: w };
        expect(parseDetail(v), `${s}=${JSON.stringify(w)}`).toEqual(parseDetailZod(v));
      }
    }
    for (const key of ["name", "category", "point", "address", "phone_numbers", "main_photo_url"]) {
      for (const w of WEIRD) {
        const v = { ...base, summary: { ...(base.summary as object), [key]: w } };
        expect(parseDetail(v), `summary.${key}=${JSON.stringify(w)}`).toEqual(parseDetailZod(v));
      }
    }
    for (const w of [Number.NaN, Number.POSITIVE_INFINITY, -0]) {
      const v = { ...base, summary: { ...(base.summary as object), point: { lat: w, lon: 127 } }, kakaomap_review: { score_set: { review_count: w, average_score: 4 } } };
      expect(parseDetail(v), String(w)).toEqual(parseDetailZod(v));
    }
  });
});
