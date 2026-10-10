import { describe, expect, it } from "vitest";
import { DETAIL_OK_TTL_MS } from "../../shared/constants";
import {
  DEVICE_CACHE_VERSION, PLACES_CACHE_FRESH_MS, PLACES_CACHE_MAX_AGE_MS, PLACES_CACHE_MAX_CHARS, PLACES_CACHE_MAX_HUBS,
  LIST_RESUME_RELOAD_MS, hubListView, mergeCachedPlaces, placesCacheEntry, placesCacheEvictions, placesDataAt, readPlacesCache,
  staleListAction, unusableCachedPlaces, type PlacesMergeState,
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
    expect(placesCacheEvictions(entries, "keep", 10).sort()).toEqual(["a", "c"]);
    expect(placesCacheEvictions([{ hub: "keep", savedAt: 1 }, { hub: "x", savedAt: 2 }], "keep", 10)).toEqual([]);
  });

  it("R45/§3.1: 저장할 때 3일(PLACES_CACHE_MAX_AGE_MS) 넘은 다른 거점 저장본은 거점 수와 상관없이 지운다 (미래 시각도) — 카카오 표시 정보를 기기에 3일 넘게 남기지 않는다", () => {
    const entries = [
      { hub: "old", savedAt: NOW - PLACES_CACHE_MAX_AGE_MS - 1 },
      { hub: "edge", savedAt: NOW - PLACES_CACHE_MAX_AGE_MS },
      { hub: "future", savedAt: NOW + HOUR },
      { hub: "keep", savedAt: NOW },
    ];
    expect(placesCacheEvictions(entries, "keep", NOW).sort()).toEqual(["future", "old"]);
  });

  it("R45/§3.1: 읽은 저장본이 쓸 수 없으면(3일 넘음·미래 시각·예전 판·깨짐) 지울 것으로 본다 — 없으면(undefined) 아무것도 하지 않는다", () => {
    const entry = placesCacheEntry("ddp", '{"places":[]}', NOW)!;
    expect(unusableCachedPlaces(entry, "ddp", NOW + PLACES_CACHE_MAX_AGE_MS)).toBe(false);
    expect(unusableCachedPlaces(entry, "ddp", NOW + PLACES_CACHE_MAX_AGE_MS + 1)).toBe(true);
    expect(unusableCachedPlaces(entry, "ddp", NOW - 1)).toBe(true);
    expect(unusableCachedPlaces({ ...entry, v: DEVICE_CACHE_VERSION + 1 }, "ddp", NOW)).toBe(true);
    expect(unusableCachedPlaces("broken", "ddp", NOW)).toBe(true);
    expect(unusableCachedPlaces(undefined, "ddp", NOW)).toBe(false);
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

  describe("hubListView", () => {
    it("R29/R21′: 거점을 바꾼 직후 이전 거점 목록은 새 목록을 받는 동안 흐리게 보이지만 그 목록으로는 뽑지 않는다", () => {
      expect(hubListView("bong-list", "bongeunsa", "pangyo", false)).toEqual({
        shown: "bong-list", listIsHub: false, drawBlock: "가게 정보를 불러오는 중이에요",
      });
    });

    it("R29/R14: 새 거점 목록을 받지 못했으면 이전 거점 목록을 보이지도 뽑지도 않는다 (처음 열 때 실패처럼 다시 시도)", () => {
      expect(hubListView("bong-list", "bongeunsa", "pangyo", true)).toEqual({
        shown: null, listIsHub: false, drawBlock: "가게 정보를 불러오지 못했어요",
      });
    });

    it("R21′: 지금 거점 목록이면 오류(최신 정보를 못 받음)여도 보여주고 뽑는다 · 목록이 없으면 불러오는 중", () => {
      expect(hubListView("pangyo-list", "pangyo", "pangyo", false)).toEqual({ shown: "pangyo-list", listIsHub: true, drawBlock: null });
      expect(hubListView("pangyo-list", "pangyo", "pangyo", true)).toEqual({ shown: "pangyo-list", listIsHub: true, drawBlock: null });
      expect(hubListView(null, null, "pangyo", false)).toEqual({ shown: null, listIsHub: false, drawBlock: "가게 정보를 불러오는 중이에요" });
      expect(hubListView(null, null, "pangyo", true)).toEqual({ shown: null, listIsHub: false, drawBlock: "가게 정보를 불러오지 못했어요" });
    });
  });

  it("R45/§3.1: 오래 열어 둔 탭으로 돌아오면 — 목록이 1시간 넘었으면 새로 받고, 3일 넘었으면 버리고 받는다 (기기 저장본 규칙과 같다)", () => {
    expect(LIST_RESUME_RELOAD_MS).toBe(HOUR);
    expect(staleListAction(null, NOW)).toBeNull();
    expect(staleListAction(NOW - HOUR, NOW)).toBeNull();
    expect(staleListAction(NOW - HOUR - 1, NOW)).toBe("reload");
    expect(staleListAction(NOW - PLACES_CACHE_MAX_AGE_MS, NOW)).toBe("reload");
    expect(staleListAction(NOW - PLACES_CACHE_MAX_AGE_MS - 1, NOW)).toBe("drop");
    // 기기 시계가 뒤로 갔으면 새로 받는다
    expect(staleListAction(NOW + HOUR, NOW)).toBe("reload");
  });

  it("R65: 목록 정보의 시각 — 기기 저장본이면 저장 시각, 새로 받은 목록이면 받은 시각", () => {
    expect(placesDataAt({ savedAt: 111 }, 999)).toBe(111);
    expect(placesDataAt(null, 999)).toBe(999);
    expect(placesDataAt(null, null)).toBeNull();
  });
});
