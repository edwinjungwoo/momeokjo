import { describe, expect, it } from "vitest";
import type { PlacesResponse } from "../../shared/types";
import { MAX_POLLS, pollDelayMs, shouldPoll } from "../../web/pollSchedule";

/** worker/app.ts PLACES_PENDING_CACHE_MS (화면 tsconfig는 worker 타입을 모른다 — 값만 맞춘다, api.test.ts가 서버 쪽 값을 고정) */
const PLACES_PENDING_CACHE_MS = 10_000;
const base: PlacesResponse = {
  center: { lat: 37.5, lng: 127 }, radius: 1000, places: [], pending: 0, incompleteTiles: 0, stale: false,
  detailsPaused: false, detailsFrozenSince: null, detailsNewestAt: null,
};

describe("R29 목록 폴링 간격", () => {
  it("R29: 10초 → 12초 → 15초(이후 15초), 최대 5번까지만 다시 부른다 — 첫 폴링이 10초 엣지 캐시(PLACES_PENDING_CACHE_MS)보다 이르지 않게", () => {
    expect(MAX_POLLS).toBe(5);
    expect([0, 1, 2, 3, 4].map(pollDelayMs)).toEqual([10_000, 12_000, 15_000, 15_000, 15_000]);
    expect(pollDelayMs(5)).toBeNull();
    expect(pollDelayMs(10)).toBeNull();
    expect(pollDelayMs(0)).toBeGreaterThanOrEqual(PLACES_PENDING_CACHE_MS);
  });

  it("R29: pending이나 수집 중 격자가 남으면 다시 부르고, 다 찼으면 멈춘다", () => {
    expect(shouldPoll(base)).toBe(false);
    expect(shouldPoll({ ...base, pending: 3 })).toBe(true);
    expect(shouldPoll({ ...base, incompleteTiles: 2 })).toBe(true);
  });

  it("R10/R44: 상세 가져오기가 멈췄으면(쿨다운·frozen) pending 때문에는 다시 부르지 않는다 (격자 수집 중이면 부른다)", () => {
    expect(shouldPoll({ ...base, pending: 3, detailsPaused: true })).toBe(false);
    expect(shouldPoll({ ...base, pending: 3, detailsPaused: true, detailsFrozenSince: 1 })).toBe(false);
    expect(shouldPoll({ ...base, pending: 3, incompleteTiles: 1, detailsPaused: true })).toBe(true);
  });

  it("R44: detailsPaused가 없는 예전 응답(기기 저장본)도 frozen이면 다시 부르지 않는다", () => {
    const old = { ...base, pending: 3, detailsFrozenSince: 1 } as Partial<PlacesResponse>;
    delete old.detailsPaused;
    expect(shouldPoll(old as PlacesResponse)).toBe(false);
    expect(shouldPoll({ ...old, detailsFrozenSince: null } as PlacesResponse)).toBe(true);
  });
});
