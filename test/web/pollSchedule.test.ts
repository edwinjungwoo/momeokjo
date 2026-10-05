import { describe, expect, it } from "vitest";
import type { PlacesResponse } from "../../shared/types";
import { MAX_POLLS, pollDelayMs, shouldPoll } from "../../web/pollSchedule";

const base: PlacesResponse = {
  center: { lat: 37.5, lng: 127 }, radius: 1000, places: [], pending: 0, incompleteTiles: 0, stale: false,
  detailsPaused: false, detailsFrozenSince: null, detailsNewestAt: null,
};

describe("R29 목록 폴링 간격", () => {
  it("R29: 3초 → 6초 → 12초로 늘리고 12초에서 멈추며, 최대 6번까지만 다시 부른다", () => {
    expect(MAX_POLLS).toBe(6);
    expect([0, 1, 2, 3, 4, 5].map(pollDelayMs)).toEqual([3000, 6000, 12_000, 12_000, 12_000, 12_000]);
    expect(pollDelayMs(6)).toBeNull();
    expect(pollDelayMs(10)).toBeNull();
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
