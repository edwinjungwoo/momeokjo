import { describe, expect, it } from "vitest";
import { MAX_RADIUS, MIN_RADIUS, PREWARM_RADIUS, isValidRadius } from "../../shared/constants";
import { DEFAULT_FILTERS } from "../../shared/recommend";
import {
  DEFAULT_SETTINGS, applyShareParams, needsHubPicker, parseSettings, resolveStart, urlAfterHubChange,
} from "../../shared/settings";

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
  it("R61: 새 기기(저장값 없음)에서 링크 없이 열면 거점을 묻는다", () => {
    expect(needsHubPicker({ stored: null, path: "/", query: "" })).toBe(true);
    // 거점을 정하지 않는 파라미터·모르는 경로·모르는 거점은 링크로 치지 않는다
    expect(needsHubPicker({ stored: null, path: "/", query: "?track=1" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/", query: "?r=700" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/brand", query: "" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/gangnam", query: "" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/", query: "?h=gangnam" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/", query: "?t=abc" })).toBe(true);
  });

  it("R61: 설정이 저장된 기존 사용자는 묻지 않는다 (예전 저장값·깨진 값 포함 — 저장값이 있으면 고른 것으로 친다)", () => {
    for (const stored of [
      JSON.stringify(DEFAULT_SETTINGS),
      JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "ddp" }),
      JSON.stringify({ filters: { ...DEFAULT_FILTERS, lunch: 30 }, center: { lat: 37.5, lng: 127 } }),
      JSON.stringify({ filters: { radius: 700 } }),
      "{oops",
    ]) {
      expect(needsHubPicker({ stored, path: "/", query: "" }), stored).toBe(false);
    }
    // 설정은 안 바꿨어도 첫 방문 안내를 닫은(뽑기를 해 본) 기기는 기존 사용자다
    expect(needsHubPicker({ stored: null, tipSeen: true, path: "/", query: "" })).toBe(false);
  });

  it("R61: 거점 짧은 링크·공유 링크(t, 예전 p·h)로 열면 묻지 않는다 (링크가 거점을 정한다)", () => {
    for (const [path, query] of [
      ["/pangyo", ""],
      ["/pangyo/", ""],
      ["/ddp", "?t=1,2&r=700"],
      ["/", "?t=1"],
      ["/", "?p=12345"],
      ["/", "?h=naebang"],
      ["/", "?t=1&h=ddp&r=300"],
    ]) {
      expect(needsHubPicker({ stored: null, path, query }), path + query).toBe(false);
    }
  });

  it("R61: 관리 화면(/admin)에서는 묻지 않는다", () => {
    expect(needsHubPicker({ stored: null, path: "/admin", query: "" })).toBe(false);
    expect(needsHubPicker({ stored: null, path: "/admin/", query: "?days=7" })).toBe(false);
  });

  it("R61: 처음 열 때 묻는지(askHub)와, 새 기기에서 링크가 정한 거점은 이 기기의 거점으로 저장한다", () => {
    expect(resolveStart(null, "/", "")).toMatchObject({ askHub: true, saveHub: null, settings: DEFAULT_SETTINGS });
    // 짧은 링크는 원래도 저장한다
    expect(resolveStart(null, "/pangyo", "")).toMatchObject({ askHub: false, saveHub: "pangyo" });
    // 새 기기의 공유 링크: 거점은 저장하고(반경은 이번에만), 주소는 /로
    const share = resolveStart(null, "/ddp", "?t=1,2&r=700");
    expect(share).toMatchObject({ askHub: false, saveHub: "ddp", replaceUrl: "/", settings: { hubId: "ddp", filters: { radius: 700 } } });
    expect(resolveStart(null, "/", "?t=1&h=naebang")).toMatchObject({ askHub: false, saveHub: "naebang" });
    // 거점이 없는 예전 공유 링크는 기본 거점을 고른 것으로 친다
    expect(resolveStart(null, "/", "?p=12345")).toMatchObject({ askHub: false, saveHub: "bongeunsa" });
    // 이미 고른 기기(저장값 또는 첫 방문 안내를 닫음)의 공유 링크 거점은 예전처럼 이번에만 (R43)
    const stored = JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "pangyo" });
    expect(resolveStart(stored, "/ddp", "?t=1")).toMatchObject({ askHub: false, saveHub: null });
    expect(resolveStart(null, "/ddp", "?t=1", true)).toMatchObject({ askHub: false, saveHub: null });
    expect(resolveStart(null, "/", "", true)).toMatchObject({ askHub: false, saveHub: null });
    expect(resolveStart(stored, "/", "")).toMatchObject({ askHub: false, saveHub: null });
  });
});
