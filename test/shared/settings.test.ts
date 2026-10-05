import { describe, expect, it } from "vitest";
import { ASEM } from "../../shared/constants";
import { DEFAULT_FILTERS } from "../../shared/recommend";
import { DEFAULT_SETTINGS, applyShareParams, parseSettings } from "../../shared/settings";

describe("settings", () => {
  it("R25: 저장값이 없거나 깨졌으면 기본값", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{oops")).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ filters: DEFAULT_FILTERS, center: ASEM });
  });

  it("R25: 유효한 필드는 살리고 잘못된 필드만 기본값으로", () => {
    const raw = JSON.stringify({
      filters: { ...DEFAULT_FILTERS, party: 4, priceCap: 15000, radius: 99999, sort: "weird" },
      center: { lat: 37.5, lng: 127.0 },
    });
    const s = parseSettings(raw);
    expect(s.filters.party).toBe(4);
    expect(s.filters.priceCap).toBe(15000);
    expect(s.filters.radius).toBe(DEFAULT_FILTERS.radius);
    expect(s.filters.sort).toBe("distance");
    expect(s.center).toEqual({ lat: 37.5, lng: 127.0 });
  });

  it("R25: 한국 밖 좌표는 ASEM으로", () => {
    expect(parseSettings(JSON.stringify({ center: { lat: 0, lng: 0 } })).center).toEqual(ASEM);
  });

  it("R23/R25: 공유 파라미터가 저장값보다 우선한다", () => {
    const s = applyShareParams(DEFAULT_SETTINGS, { placeId: "1", center: { lat: 37.5, lng: 127.05 }, radius: 300 });
    expect(s.center).toEqual({ lat: 37.5, lng: 127.05 });
    expect(s.filters).toMatchObject({ radius: 300, lunch: 30 });
    expect(applyShareParams(DEFAULT_SETTINGS, { placeId: null, center: null, radius: 850 }).filters).toMatchObject({
      radius: 850, lunch: null,
    });
    expect(applyShareParams(DEFAULT_SETTINGS, { placeId: null, center: null, radius: null })).toEqual(DEFAULT_SETTINGS);
  });
});
