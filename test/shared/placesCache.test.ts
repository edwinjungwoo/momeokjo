import { describe, expect, it } from "vitest";
import { DETAIL_OK_TTL_MS } from "../../shared/constants";
import {
  DEVICE_CACHE_VERSION, PLACES_CACHE_FRESH_MS, PLACES_CACHE_MAX_AGE_MS, PLACES_CACHE_MAX_CHARS, PLACES_CACHE_MAX_HUBS,
  mergeCachedPlaces, placesCacheEntry, placesCacheEvictions, placesDataAt, readPlacesCache, type PlacesMergeState,
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

  it("R56: 응답의 ETag를 같이 저장해 두고 읽을 때 돌려준다 (예전 저장본·이상한 값은 ETag 없이)", () => {
    const e = placesCacheEntry("ddp", "{}", NOW, 'W/"1-ddp-abc"')!;
    expect(e).toEqual({ v: DEVICE_CACHE_VERSION, hub: "ddp", savedAt: NOW, text: "{}", etag: 'W/"1-ddp-abc"' });
    expect(readPlacesCache(e, "ddp", NOW)).toEqual({ text: "{}", savedAt: NOW, fresh: true, etag: 'W/"1-ddp-abc"' });
    expect(placesCacheEntry("ddp", "{}", NOW, null)).not.toHaveProperty("etag");
    expect(readPlacesCache(placesCacheEntry("ddp", "{}", NOW), "ddp", NOW)).not.toHaveProperty("etag");
    for (const etag of [1, "", "x".repeat(300)]) {
      expect(readPlacesCache({ ...placesCacheEntry("ddp", "{}", NOW), etag }, "ddp", NOW)).not.toHaveProperty("etag");
    }
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

  describe("mergeCachedPlaces", () => {
    type S = PlacesMergeState<string>;
    const initial: S = { data: null, hub: null, cache: null, loading: true, error: false, polling: false };
    const fresh = { data: "cached", savedAt: NOW - HOUR, fresh: true };
    const stale = { data: "cached", savedAt: NOW - 30 * HOUR, fresh: false };

    it("R45: 저장본이 먼저 오면 보여주고, 신선하면 흐리게 하지 않는다 (loading 끔)", () => {
      expect(mergeCachedPlaces(initial, "ddp", fresh)).toEqual({
        data: "cached", hub: "ddp", cache: { savedAt: NOW - HOUR, fresh: true }, loading: false, error: false, polling: false,
      });
    });

    it("R45: 하루 넘은 저장본은 새 목록이 올 때까지 loading을 유지해 흐리게 두고, 이미 끝난 로딩을 되살리지는 않는다", () => {
      const merged = mergeCachedPlaces(initial, "ddp", stale);
      expect(merged.loading).toBe(true);
      expect(mergeCachedPlaces({ ...initial, loading: false, error: true }, "ddp", stale).loading).toBe(false);
      expect(merged.cache).toEqual({ savedAt: NOW - 30 * HOUR, fresh: false });
    });

    it("R45: 네트워크 목록이 저장본보다 먼저 왔으면 저장본은 버린다", () => {
      const net: S = { ...initial, data: "net", hub: "ddp", loading: false };
      expect(mergeCachedPlaces(net, "ddp", fresh)).toBe(net);
    });

    it("R45: 저장본 뒤에 네트워크가 실패해도 저장본을 두고 오류 상태를 함께 보인다", () => {
      const shown = mergeCachedPlaces(initial, "ddp", stale);
      const failed: S = { ...shown, loading: false, error: true, polling: false }; // usePlaces catch와 같은 변화 (화면은 fromCache === "stale"이면 계속 흐리게)
      expect(failed.data).toBe("cached");
      expect(failed.error).toBe(true);
      // 반대 순서(실패가 먼저, 저장본이 나중): 오류는 그대로 두고 저장본만 채운다
      const errorFirst: S = { ...initial, loading: false, error: true };
      expect(mergeCachedPlaces(errorFirst, "ddp", fresh)).toMatchObject({ data: "cached", error: true, loading: false });
    });

    it("R45: 다시 시도에서 이 거점의 네트워크 목록을 들고 있으면 저장본을 쓰지 않는다 (저장본 표시 중이면 새로 받은 것으로 바뀌기 전까지 저장본)", () => {
      const net: S = { ...initial, data: "net", hub: "ddp", loading: true };
      expect(mergeCachedPlaces(net, "ddp", stale)).toBe(net);
      const showingCache = mergeCachedPlaces(initial, "ddp", fresh);
      expect(mergeCachedPlaces(showingCache, "ddp", stale).cache?.fresh).toBe(false); // 저장본끼리는 새 쪽으로
    });

    it("R45: 다른 거점의 목록을 들고 있으면 이 거점의 저장본으로 바꾼다 (이전 거점 목록은 남기지 않는다)", () => {
      const other: S = { ...initial, data: "net-other", hub: "bongeunsa", loading: false };
      expect(mergeCachedPlaces(other, "ddp", fresh)).toMatchObject({ data: "cached", hub: "ddp" });
    });
  });

  it("R65: 목록 정보의 시각 — 기기 저장본이면 저장 시각, 새로 받은 목록이면 받은 시각", () => {
    expect(placesDataAt({ savedAt: 111 }, 999)).toBe(111);
    expect(placesDataAt(null, 999)).toBe(999);
    expect(placesDataAt(null, null)).toBeNull();
  });
});
