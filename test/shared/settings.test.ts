import { describe, expect, it } from "vitest";
import { MAX_RADIUS, MIN_RADIUS, PREWARM_RADIUS, isValidRadius } from "../../shared/constants";
import { DEFAULT_FILTERS } from "../../shared/recommend";
import { DEFAULT_SETTINGS, applyShareParams, parseSettings, resolveStart, urlAfterHubChange } from "../../shared/settings";

describe("settings", () => {
  it("R16: 반경은 100~1000m, 50m 단위이고 상한은 Cron 사전 수집 반경과 같다", () => {
    expect([MIN_RADIUS, MAX_RADIUS, PREWARM_RADIUS]).toEqual([100, 1000, 1000]);
    expect([100, 150, 500, 1000].every(isValidRadius)).toBe(true);
    expect([50, 125, 1050, 500.5, Number.NaN].some(isValidRadius)).toBe(false);
  });

  it("R25: 저장값이 없거나 깨졌으면 기본값 (기본 거점 봉은사역)", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{oops")).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ filters: DEFAULT_FILTERS, hubId: "bongeunsa" });
  });

  it("R25: 유효한 필드는 살리고 잘못된 필드만 기본값으로", () => {
    const raw = JSON.stringify({
      filters: { ...DEFAULT_FILTERS, party: 4, priceCap: 15000, radius: 99999, sort: "weird" },
      hubId: "ddp",
    });
    const s = parseSettings(raw);
    expect(s.filters.party).toBe(4);
    expect(s.filters.priceCap).toBe(15000);
    expect(s.filters.radius).toBe(DEFAULT_FILTERS.radius);
    expect(s.filters.sort).toBe("distance");
    expect(s.hubId).toBe("ddp");
    expect(parseSettings(JSON.stringify({ filters: { radius: 1001 } })).filters.radius).toBe(500);
    expect(parseSettings(JSON.stringify({ filters: { radius: 850 } })).filters.radius).toBe(850);
    // 50m 단위가 아니면 기본값 (캐시 키를 적게 유지)
    expect(parseSettings(JSON.stringify({ filters: { radius: 825 } })).filters.radius).toBe(500);
  });

  it("R25/R45: 손으로 검증해도 예전(zod) 규칙과 같다 — 모양이 틀린 값은 필드별로, 루트가 틀리면 전체 기본값", () => {
    for (const raw of ["null", "[]", "5", '"x"', "{}"]) expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ filters: [], hubId: "ddp" }))).toEqual({ filters: DEFAULT_FILTERS, hubId: "ddp" });
    expect(parseSettings(JSON.stringify({ filters: null, hubId: 3 }))).toEqual(DEFAULT_SETTINGS);
    const s = parseSettings(
      JSON.stringify({
        filters: { radius: "500", party: "2", groups: ["korean", "pizza"], includeBar: 1, priceCap: "10000", minRating: 3, openOnly: "y", sort: 1 },
      }),
    );
    expect(s.filters).toEqual(DEFAULT_FILTERS);
    const ok = parseSettings(
      JSON.stringify({
        filters: { radius: 300, party: 1, groups: ["korean", "etc"], includeBar: true, priceCap: 20000, minRating: 3.5, openOnly: false, sort: "price", x: 1 },
        hubId: "pangyo",
        extra: true,
      }),
    );
    expect(ok).toEqual({
      filters: { radius: 300, party: 1, groups: ["korean", "etc"], includeBar: true, priceCap: 20000, minRating: 3.5, openOnly: false, sort: "price" },
      hubId: "pangyo",
    });
    // 술집(bar)·디저트는 카테고리 칩에 없어서 저장값으로도 받지 않는다
    expect(parseSettings(JSON.stringify({ filters: { groups: ["bar"] } })).filters.groups).toEqual(DEFAULT_FILTERS.groups);
  });

  it("R25: 모르는 거점은 기본 거점으로, 예전 저장값(center, lunch)은 버린다", () => {
    expect(parseSettings(JSON.stringify({ hubId: "gangnam" })).hubId).toBe("bongeunsa");
    const old = parseSettings(JSON.stringify({ filters: { ...DEFAULT_FILTERS, lunch: 30 }, center: { lat: 37.5, lng: 127 } }));
    expect(old).toEqual(DEFAULT_SETTINGS);
    expect(old).not.toHaveProperty("center");
    expect(old.filters).not.toHaveProperty("lunch");
  });

  it("R23/R25: 공유 파라미터(거점, 반경)가 저장값보다 우선한다", () => {
    const s = applyShareParams(DEFAULT_SETTINGS, { placeIds: ["1"], hubId: "ddp", radius: 300 });
    expect(s.hubId).toBe("ddp");
    expect(s.filters.radius).toBe(300);
    expect(applyShareParams(DEFAULT_SETTINGS, { placeIds: [], hubId: null, radius: 850 })).toEqual({
      ...DEFAULT_SETTINGS, filters: { ...DEFAULT_FILTERS, radius: 850 },
    });
    expect(applyShareParams(DEFAULT_SETTINGS, { placeIds: [], hubId: null, radius: null })).toEqual(DEFAULT_SETTINGS);
  });

  it("R25: 공유 파라미터를 적용해도 저장값 객체는 바뀌지 않는다", () => {
    const stored = parseSettings(JSON.stringify({ filters: { ...DEFAULT_FILTERS, party: 4, radius: 700 }, hubId: "pangyo" }));
    const snapshot = structuredClone(stored);
    const s = applyShareParams(stored, { placeIds: ["1"], hubId: "ddp", radius: 300 });
    expect(s).toMatchObject({ hubId: "ddp", filters: { radius: 300, party: 4 } });
    expect(stored).toEqual(snapshot);
    expect(DEFAULT_SETTINGS.filters.radius).toBe(500);
  });

  it("R43/R25: 거점 경로로 열면 그 거점을 쓰고 저장한다 (주소창은 그대로)", () => {
    const stored = JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "ddp" });
    const r = resolveStart(stored, "/pangyo", "");
    expect(r.settings.hubId).toBe("pangyo");
    expect(r.saveHub).toBe("pangyo");
    expect(r.replaceUrl).toBeNull();
    // 공유가 아닌 다른 파라미터만 있으면 지우되 경로는 남긴다
    const q = resolveStart(stored, "/pangyo/", "?r=700");
    expect(q.settings).toMatchObject({ hubId: "pangyo", filters: { radius: 700 } });
    expect(q.saveHub).toBe("pangyo");
    expect(q.replaceUrl).toBe("/pangyo/");
  });

  it("R43/R25: 공유 링크의 거점 경로는 이번에만 쓰고 저장하지 않으며, 주소는 /로 돌린다", () => {
    const stored = JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "pangyo" });
    const r = resolveStart(stored, "/bongeunsa", "?t=1,2&r=700");
    expect(r.settings).toMatchObject({ hubId: "bongeunsa", filters: { radius: 700 } });
    expect(r.share.placeIds).toEqual(["1", "2"]);
    expect(r.saveHub).toBeNull();
    expect(r.replaceUrl).toBe("/");
    // 예전 링크도 같다
    const old = resolveStart(stored, "/", "?t=1&h=ddp&r=300");
    expect(old.settings.hubId).toBe("ddp");
    expect(old.saveHub).toBeNull();
    expect(old.replaceUrl).toBe("/");
  });

  it("R43/R25: 모르는 경로와 파라미터 없는 루트는 저장값 그대로", () => {
    const stored = JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "naebang" });
    expect(resolveStart(stored, "/brand", "")).toMatchObject({ saveHub: null, replaceUrl: null, settings: { hubId: "naebang" } });
    expect(resolveStart(stored, "/", "")).toMatchObject({ saveHub: null, replaceUrl: null, settings: { hubId: "naebang" } });
  });

  it("R43/R25: 거점 경로로 연 뒤 손으로 거점을 바꾸면 주소를 /로 돌린다 (새로고침이 북마크 거점으로 되돌리지 않게)", () => {
    expect(urlAfterHubChange("/ddp")).toBe("/");
    expect(urlAfterHubChange("/pangyo/")).toBe("/");
    // 거점 경로가 아니면 주소를 건드리지 않는다
    expect(urlAfterHubChange("/")).toBeNull();
    expect(urlAfterHubChange("/brand")).toBeNull();
    expect(urlAfterHubChange("/admin")).toBeNull();
  });
});
