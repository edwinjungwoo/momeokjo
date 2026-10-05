import { describe, expect, it } from "vitest";
import { DETAIL_OK_TTL_MS } from "../../shared/constants";
import {
  DEVICE_CACHE_VERSION, PLACES_CACHE_FRESH_MS, PLACES_CACHE_MAX_AGE_MS, PLACES_CACHE_MAX_CHARS, PLACES_CACHE_MAX_HUBS,
  placesCacheEntry, placesCacheEvictions, readPlacesCache,
} from "../../shared/placesCache";

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

describe("placesCache", () => {
  it("R45: 거점마다 응답 원문을 버전·저장 시각과 함께 저장하고, 너무 크거나 비면 저장하지 않는다", () => {
    expect(placesCacheEntry("bongeunsa", '{"places":[]}', NOW)).toEqual({
      v: DEVICE_CACHE_VERSION, hub: "bongeunsa", savedAt: NOW, text: '{"places":[]}',
    });
    expect(placesCacheEntry("bongeunsa", "", NOW)).toBeNull();
    expect(placesCacheEntry("bongeunsa", "x".repeat(PLACES_CACHE_MAX_CHARS + 1), NOW)).toBeNull();
    expect(PLACES_CACHE_MAX_CHARS).toBeGreaterThanOrEqual(1_500_000); // 동대문 1000m ≈ 1.0MB가 들어간다
  });

  it("R45: 24시간 안의 저장본은 fresh, 24시간~3일은 보여주되 fresh 아님, 3일 넘거나 미래 시각이면 버린다", () => {
    // 기기 저장본은 서버의 상세 유지 기간(3일, 스펙 §3.1을 보수적으로 읽음)보다 오래 두지 않는다
    expect(PLACES_CACHE_FRESH_MS).toBe(24 * HOUR);
    expect(PLACES_CACHE_MAX_AGE_MS).toBe(3 * 24 * HOUR);
    expect(PLACES_CACHE_MAX_AGE_MS).toBe(DETAIL_OK_TTL_MS);
    const e = placesCacheEntry("ddp", "{}", NOW)!;
    expect(readPlacesCache(e, "ddp", NOW + HOUR)).toEqual({ text: "{}", savedAt: NOW, fresh: true });
    expect(readPlacesCache(e, "ddp", NOW + PLACES_CACHE_FRESH_MS)?.fresh).toBe(true);
    expect(readPlacesCache(e, "ddp", NOW + PLACES_CACHE_FRESH_MS + 1)?.fresh).toBe(false);
    expect(readPlacesCache(e, "ddp", NOW + PLACES_CACHE_MAX_AGE_MS)?.fresh).toBe(false);
    expect(readPlacesCache(e, "ddp", NOW + PLACES_CACHE_MAX_AGE_MS + 1)).toBeNull();
    expect(readPlacesCache(e, "ddp", NOW - 1)).toBeNull();
  });

  it("R45: 다른 거점·다른 버전·깨진 값은 읽지 않는다", () => {
    const e = placesCacheEntry("ddp", "{}", NOW)!;
    expect(readPlacesCache(e, "pangyo", NOW)).toBeNull();
    expect(readPlacesCache({ ...e, v: DEVICE_CACHE_VERSION + 1 }, "ddp", NOW)).toBeNull();
    for (const bad of [undefined, null, "x", 3, {}, { ...e, text: 1 }, { ...e, text: "" }, { ...e, savedAt: "1" }]) {
      expect(readPlacesCache(bad, "ddp", NOW)).toBeNull();
    }
  });

  it("R45: 저장 뒤 방금 거점을 빼고 최근 저장 순으로 MAX_HUBS개만 남긴다", () => {
    expect(PLACES_CACHE_MAX_HUBS).toBe(3);
    const entries = [
      { hub: "a", savedAt: 1 }, { hub: "b", savedAt: 5 }, { hub: "c", savedAt: 3 }, { hub: "d", savedAt: 4 }, { hub: "keep", savedAt: 0 },
    ];
    expect(placesCacheEvictions(entries, "keep").sort()).toEqual(["a", "c"]);
    expect(placesCacheEvictions([{ hub: "keep", savedAt: 1 }, { hub: "x", savedAt: 2 }], "keep")).toEqual([]);
  });
});
