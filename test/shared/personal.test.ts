import { describe, expect, it } from "vitest";
import {
  EMPTY_PERSONAL, FAVORITE_BOOST, MAX_FAVORITES, MAX_NAME_LENGTH, MAX_SIGNALS, MAX_SNAPSHOTS, addFavorite, addSignals,
  categoryFatigue, decay, excludePlace, groupBoost, includePlace, isFavorite, parsePersonal, personalMultiplier, pruneSnapshots,
  recencyFactor, removeFavorite, saveSnapshots, type PersonalState, type Signal, type Snapshot,
} from "../../shared/personal";

const NOW = Date.parse("2026-10-05T12:00:00+09:00");
const H = 3600_000;
const D = 24 * H;
const sig = (kind: Signal["kind"], ageMs: number, id = "1", group: Signal["group"] = "korean"): Signal => ({
  id, group, kind, at: NOW - ageMs,
});
const state = (...signals: Signal[]): PersonalState => ({ ...EMPTY_PERSONAL, signals });
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

  it("R37: 최종 배수 = 최근 신호 배수 × 그룹 가산, '다음부터 안 보기'면 0", () => {
    const s = state(sig("kakao_open", 0, "1"), sig("shared", H, "2")); // 서로 다른 때 = 취향 신호 2번
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

  it("R37: 300개를 채우는 약한 신호(보여줌)가 오래된 취향 신호(카카오맵)를 밀어내지 않는다", () => {
    const shown = Array.from({ length: MAX_SIGNALS }, (_, i) => sig("shown", i * 1000, `s${i}`));
    const s = addSignals(state(sig("kakao_open", 10 * D, "k")), shown, NOW);
    expect(s.signals).toHaveLength(MAX_SIGNALS);
    expect(s.signals.some((x) => x.id === "k")).toBe(true);
    // 정리할 때 취향 신호를 먼저 남기고, 약한 신호 중 오래된 것부터 줄인다
    expect(s.signals.some((x) => x.id === `s${MAX_SIGNALS - 1}`)).toBe(false);
    expect(s.signals.some((x) => x.id === "s0")).toBe(true);
  });

  it("R37: 효과가 끝난 신호는 버린다 — 보여줌 1일, 받음 3일, 취향 신호 30일", () => {
    const s = addSignals(
      EMPTY_PERSONAL,
      [
        sig("shown", 2 * D, "shown-old"), sig("shown", 12 * H, "shown-ok"),
        sig("received", 4 * D, "recv-old"), sig("received", 2 * D, "recv-ok"),
        sig("shared", 10 * D, "shared-ok"), sig("kakao_open", 29 * D, "kakao-ok"), sig("kakao_open", 31 * D, "kakao-old"),
      ],
      NOW,
    );
    expect(s.signals.map((x) => x.id).sort()).toEqual(["kakao-ok", "recv-ok", "shared-ok", "shown-ok"]);
  });

  it("R37: 공유 1번(3곳)은 그룹 가산 1번으로 센다", () => {
    const trio = ["1", "2", "3"].map((id) => sig("shared", D, id));
    expect(groupBoost(state(...trio), "korean", NOW)).toBeCloseTo(1.15, 9);
    const twice = [...trio, ...["4", "5", "6"].map((id) => sig("shared", 2 * D, id))];
    expect(groupBoost(state(...twice), "korean", NOW)).toBeCloseTo(1.3, 9);
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
      // R65: 즐겨찾기·이름 기억이 없는 예전 저장값은 빈 값으로
      favorites: {},
      snapshots: {},
    });
  });
});

describe("R40 최근 먹은 종류 피로도", () => {
  const withCat = (kind: Signal["kind"], ageMs: number, cat: string | undefined, id = "9"): Signal => ({
    ...sig(kind, ageMs, id), ...(cat === undefined ? {} : { cat }),
  });
  const gukbap = (id: string, group: Signal["group"] = "korean") => ({ id, group, category: "음식점 > 한식 > 국밥" });

  it("R40: 어제 카카오맵을 연 '국밥'은 오늘 ×0.6, 36시간 뒤엔 1", () => {
    expect(categoryFatigue(state(withCat("kakao_open", 20 * H, "국밥")), "국밥", NOW)).toBeCloseTo(0.6, 9);
    expect(categoryFatigue(state(withCat("kakao_open", 36 * H, "국밥")), "국밥", NOW)).toBeCloseTo(0.6, 9);
    expect(categoryFatigue(state(withCat("kakao_open", 36 * H + 1, "국밥")), "국밥", NOW)).toBe(1);
    // 다른 종류, 보여줌·받음, cat이 없는 예전 신호, 빈 종류는 세지 않는다
    expect(categoryFatigue(state(withCat("kakao_open", H, "라멘")), "국밥", NOW)).toBe(1);
    expect(categoryFatigue(state(withCat("shown", H, "국밥"), withCat("received", H, "국밥")), "국밥", NOW)).toBe(1);
    expect(categoryFatigue(state(withCat("kakao_open", H, undefined)), "국밥", NOW)).toBe(1);
    expect(categoryFatigue(state(withCat("kakao_open", H, "")), "", NOW)).toBe(1);
  });

  it("R40: 1번마다 ×0.6, 바닥 0.4, 같은 시각(공유 1번)은 1번으로 센다", () => {
    const s2 = state(withCat("kakao_open", H, "국밥", "1"), withCat("shared", 2 * H, "국밥", "2"));
    expect(categoryFatigue(s2, "국밥", NOW)).toBeCloseTo(0.4, 9); // 0.36 → 바닥 0.4
    const oneShare = state(withCat("shared", H, "국밥", "1"), withCat("shared", H, "국밥", "2"));
    expect(categoryFatigue(oneShare, "국밥", NOW)).toBeCloseTo(0.6, 9);
  });

  it("R40: 피로도와 30일 그룹 가산은 함께 곱한다", () => {
    const s = state(withCat("kakao_open", 20 * H, "국밥", "1"));
    // 다른 국밥집 2: 최근 신호 없음(1) × 그룹 가산 1.15 × 피로도 0.6
    expect(personalMultiplier(s, gukbap("2"), NOW)).toBeCloseTo(1.15 * 0.6, 9);
    // 종류가 다른 한식집: 피로도 없음
    expect(personalMultiplier(s, { id: "3", group: "korean", category: "음식점 > 한식 > 냉면" }, NOW)).toBeCloseTo(1.15, 9);
    // 카테고리를 모르는 곳(예전 호출)은 피로도 없음
    expect(personalMultiplier(s, place("4"), NOW)).toBeCloseTo(1.15, 9);
  });

  it("R40: 저장값의 cat은 30자 이하 글자만 남기고, 없거나 틀리면 cat 없이 신호를 살린다", () => {
    const raw = JSON.stringify({
      signals: [
        { id: "1", group: "korean", kind: "shared", at: NOW, cat: "국밥" },
        { id: "2", group: "korean", kind: "shared", at: NOW, cat: 5 },
        { id: "3", group: "korean", kind: "shared", at: NOW, cat: "가".repeat(31) },
        { id: "4", group: "korean", kind: "shared", at: NOW },
      ],
      excluded: {},
    });
    expect(parsePersonal(raw).signals).toEqual([
      { id: "1", group: "korean", kind: "shared", at: NOW, cat: "국밥" },
      { id: "2", group: "korean", kind: "shared", at: NOW },
      { id: "3", group: "korean", kind: "shared", at: NOW },
      { id: "4", group: "korean", kind: "shared", at: NOW },
    ]);
  });
});

describe("R65 내 가게 — 즐겨찾기·이름 기억 (기기 안에서만)", () => {
  const snap = (name: string, at = NOW, o: Partial<Snapshot> = {}): Snapshot => ({
    name, group: "korean", lat: 37.514, lng: 127.06, at, ...o,
  });
  const src = (id: string, name = `가게${id}`) => ({
    id, name, group: "korean" as const, category: "음식점 > 한식 > 국밥", lat: 37.514, lng: 127.06,
  });

  it("R65: 즐겨찾기 넣기·빼기 — 원래 상태는 그대로, 넣은 시각을 기억한다", () => {
    const s = addFavorite(EMPTY_PERSONAL, "7", NOW);
    expect(s.favorites).toEqual({ "7": NOW });
    expect(isFavorite(s, "7")).toBe(true);
    expect(isFavorite(s, "8")).toBe(false);
    expect(EMPTY_PERSONAL.favorites).toEqual({});
    const off = removeFavorite(s, "7");
    expect(off.favorites).toEqual({});
    expect(isFavorite(off, "7")).toBe(false);
    expect(s.favorites).toEqual({ "7": NOW });
    // 이미 있으면 시각만 새로
    expect(addFavorite(s, "7", NOW + H).favorites).toEqual({ "7": NOW + H });
  });

  it("R65: 즐겨찾기는 최대 100곳 — 넘치면 가장 오래 전에 넣은 곳부터 뺀다", () => {
    let s = EMPTY_PERSONAL;
    for (let i = 0; i < MAX_FAVORITES; i++) s = addFavorite(s, String(i + 1), NOW + i);
    expect(MAX_FAVORITES).toBe(100);
    expect(Object.keys(s.favorites)).toHaveLength(MAX_FAVORITES);
    s = addFavorite(s, "999", NOW + 1000);
    expect(Object.keys(s.favorites)).toHaveLength(MAX_FAVORITES);
    expect(isFavorite(s, "1")).toBe(false);
    expect(isFavorite(s, "2")).toBe(true);
    expect(isFavorite(s, "999")).toBe(true);
  });

  it("R65: 뺀 곳을 즐겨찾기에 넣으면 '다음부터 안 보기'가 풀린다", () => {
    const hidden = excludePlace(EMPTY_PERSONAL, "3", NOW);
    const fav = addFavorite(hidden, "3", NOW + H);
    expect(fav.excluded).toEqual({});
    expect(isFavorite(fav, "3")).toBe(true);
    expect(personalMultiplier(fav, place("3"), NOW + H)).toBeCloseTo(FAVORITE_BOOST, 9);
  });

  it("R65: 즐겨찾기는 ×1.3 — 최근 신호·그룹 가산·피로도와 함께 곱하고, 빼 둔 곳은 언제나 0", () => {
    expect(FAVORITE_BOOST).toBe(1.3);
    const fav = addFavorite(EMPTY_PERSONAL, "1", NOW);
    expect(personalMultiplier(fav, place("1"), NOW)).toBeCloseTo(1.3, 9);
    expect(personalMultiplier(fav, place("2"), NOW)).toBe(1);
    // 방금 카카오맵을 연 즐겨찾기도 며칠은 쉰다: 0.15(최근) × 1.15(그룹) × 1.3
    const visited = addFavorite(state(sig("kakao_open", 0, "1")), "1", NOW);
    expect(personalMultiplier(visited, place("1"), NOW)).toBeCloseTo(0.15 * 1.15 * 1.3, 9);
    // R40 피로도도 곱한다: 어제 국밥집 2를 연 뒤 국밥집 1(즐겨찾기) = 1.15 × 0.6 × 1.3
    const tired = addFavorite(state({ ...sig("kakao_open", 20 * H, "2"), cat: "국밥" }), "1", NOW);
    expect(personalMultiplier(tired, { ...place("1"), category: "음식점 > 한식 > 국밥" }, NOW)).toBeCloseTo(1.15 * 0.6 * 1.3, 9);
    // 즐겨찾기를 그대로 둔 채 빼면(저장값이 그렇게 왔어도) 뺀 것이 이긴다
    const both: PersonalState = { ...fav, excluded: { "1": NOW } };
    expect(personalMultiplier(both, place("1"), NOW)).toBe(0);
  });

  it("R65: 이름 기억 — 이름·그룹·세부 종류·좌표·시각을 남기고, 다시 남기면 새 값으로", () => {
    const s = saveSnapshots(EMPTY_PERSONAL, [src("5", "중앙해장")], NOW);
    expect(s.snapshots).toEqual({
      "5": { name: "중앙해장", group: "korean", cat: "국밥", lat: 37.514, lng: 127.06, at: NOW },
    });
    expect(EMPTY_PERSONAL.snapshots).toEqual({});
    const again = saveSnapshots(s, [{ ...src("5", "중앙해장 본점"), category: "" }], NOW + H);
    expect(again.snapshots["5"]).toEqual({ name: "중앙해장 본점", group: "korean", lat: 37.514, lng: 127.06, at: NOW + H });
    // 긴 이름은 잘라서 남긴다, 틀린 id·좌표는 남기지 않는다
    const long = saveSnapshots(EMPTY_PERSONAL, [src("6", "가".repeat(MAX_NAME_LENGTH + 5))], NOW);
    expect(long.snapshots["6"].name).toBe("가".repeat(MAX_NAME_LENGTH));
    const bad = saveSnapshots(EMPTY_PERSONAL, [src("x1"), { ...src("7"), lat: Number.NaN }, { ...src("8"), name: "" }], NOW);
    expect(bad.snapshots).toEqual({});
  });

  it("R65: 이름 기억 정리 — 즐겨찾기·뺀 곳·최근 30일 카카오맵/공유가 가리키는 것만 남긴다", () => {
    const base: PersonalState = {
      ...EMPTY_PERSONAL,
      signals: [sig("kakao_open", 2 * D, "recent"), sig("shared", D, "shared"), sig("shown", H, "shown"), sig("kakao_open", 31 * D, "old")],
      favorites: { fav: NOW },
      excluded: { hid: NOW },
      snapshots: {
        fav: snap("즐겨찾기", NOW - 90 * D), hid: snap("뺀 곳"), recent: snap("최근"), shared: snap("공유"),
        shown: snap("보여줌"), old: snap("오래된 카카오맵"), loose: snap("아무것도 아님"),
      },
    };
    expect(Object.keys(pruneSnapshots(base, NOW).snapshots).sort()).toEqual(["fav", "hid", "recent", "shared"]);
  });

  it("R65: 이름 기억은 최대 200곳 — 넘치면 즐겨찾기는 지키고 오래된 것부터 버린다", () => {
    expect(MAX_SNAPSHOTS).toBe(200);
    const excluded: Record<string, number> = {};
    const snapshots: Record<string, Snapshot> = {};
    for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) {
      excluded[`${i + 1}`] = NOW;
      snapshots[`${i + 1}`] = snap(`가게${i + 1}`, NOW - (MAX_SNAPSHOTS + 10 - i) * H); // 1이 가장 오래됨
    }
    snapshots["9000"] = snap("아주 오래된 즐겨찾기", NOW - 365 * D);
    const s = pruneSnapshots({ ...EMPTY_PERSONAL, excluded, favorites: { "9000": NOW }, snapshots }, NOW);
    const kept = Object.keys(s.snapshots);
    expect(kept).toHaveLength(MAX_SNAPSHOTS);
    expect(kept).toContain("9000");
    expect(kept).not.toContain("1");
    expect(kept).not.toContain("11");
    expect(kept).toContain("12");
    expect(kept).toContain(`${MAX_SNAPSHOTS + 10}`);
  });

  it("R65: 저장값 파싱 — 즐겨찾기·이름 기억도 틀린 항목만 버린다 (예전 저장값은 빈 값으로)", () => {
    const old = parsePersonal(JSON.stringify({ signals: [], excluded: { "5": NOW } }));
    expect(old.favorites).toEqual({});
    expect(old.snapshots).toEqual({});
    const raw = JSON.stringify({
      signals: [],
      excluded: {},
      favorites: { "1": NOW, x: NOW, "2": "y", "3": Number.MAX_VALUE * 2 },
      snapshots: {
        "1": { name: "중앙해장", group: "korean", cat: "해장국", lat: 37.5, lng: 127.0, at: NOW },
        "2": { name: "카테고리 이상", group: "korean", cat: 5, lat: 37.5, lng: 127.0, at: NOW },
        "3": { name: "", group: "korean", lat: 37.5, lng: 127.0, at: NOW },
        "4": { name: "가".repeat(MAX_NAME_LENGTH + 1), group: "korean", lat: 37.5, lng: 127.0, at: NOW },
        "5": { name: "그룹 이상", group: "pizza", lat: 37.5, lng: 127.0, at: NOW },
        "6": { name: "좌표 이상", group: "korean", lat: "37.5", lng: 127.0, at: NOW },
        "7": { name: "위도 범위 밖", group: "korean", lat: 137.5, lng: 127.0, at: NOW },
        "8": { name: "시각 없음", group: "korean", lat: 37.5, lng: 127.0 },
        x: { name: "id 이상", group: "korean", lat: 37.5, lng: 127.0, at: NOW },
        "9": "문자열",
      },
    });
    const s = parsePersonal(raw);
    expect(s.favorites).toEqual({ "1": NOW });
    expect(s.snapshots).toEqual({
      "1": { name: "중앙해장", group: "korean", cat: "해장국", lat: 37.5, lng: 127.0, at: NOW },
      "2": { name: "카테고리 이상", group: "korean", lat: 37.5, lng: 127.0, at: NOW },
    });
    // 배열·문자열 같은 엉뚱한 모양이어도 앱이 죽지 않는다
    expect(parsePersonal(JSON.stringify({ signals: [], excluded: {}, favorites: [1], snapshots: "x" }))).toEqual(EMPTY_PERSONAL);
    // 즐겨찾기가 100곳을 넘게 저장돼 있으면 최근 100곳만
    const many = Object.fromEntries(Array.from({ length: MAX_FAVORITES + 3 }, (_, i) => [String(i + 1), NOW + i]));
    const capped = parsePersonal(JSON.stringify({ signals: [], excluded: {}, favorites: many }));
    expect(Object.keys(capped.favorites)).toHaveLength(MAX_FAVORITES);
    expect(capped.favorites["1"]).toBeUndefined();
    expect(capped.favorites[String(MAX_FAVORITES + 3)]).toBe(NOW + MAX_FAVORITES + 2);
  });
});
