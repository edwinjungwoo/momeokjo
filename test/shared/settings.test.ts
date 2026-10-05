import { describe, expect, it } from "vitest";
import { MAX_RADIUS, MIN_RADIUS, PREWARM_RADIUS, isValidRadius } from "../../shared/constants";
import { DEFAULT_FILTERS } from "../../shared/recommend";
import { DEFAULT_SETTINGS, applyShareParams, parseSettings } from "../../shared/settings";

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

  it("R25: 모르는 거점은 기본 거점으로, 예전 저장값(center, lunch)은 버린다", () => {
    expect(parseSettings(JSON.stringify({ hubId: "gangnam" })).hubId).toBe("bongeunsa");
    const old = parseSettings(JSON.stringify({ filters: { ...DEFAULT_FILTERS, lunch: 30 }, center: { lat: 37.5, lng: 127 } }));
    expect(old).toEqual(DEFAULT_SETTINGS);
    expect(old).not.toHaveProperty("center");
    expect(old.filters).not.toHaveProperty("lunch");
  });

  it("R23/R25: 공유 파라미터(거점, 반경)가 저장값보다 우선한다", () => {
    const s = applyShareParams(DEFAULT_SETTINGS, { placeId: "1", hubId: "ddp", radius: 300 });
    expect(s.hubId).toBe("ddp");
    expect(s.filters.radius).toBe(300);
    expect(applyShareParams(DEFAULT_SETTINGS, { placeId: null, hubId: null, radius: 850 })).toEqual({
      ...DEFAULT_SETTINGS, filters: { ...DEFAULT_FILTERS, radius: 850 },
    });
    expect(applyShareParams(DEFAULT_SETTINGS, { placeId: null, hubId: null, radius: null })).toEqual(DEFAULT_SETTINGS);
  });
});
