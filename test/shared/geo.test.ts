import { describe, expect, it } from "vitest";
import { ASEM, TILE_LAT, TILE_LNG } from "../../shared/constants";
import {
  boundingBox, haversine, splitRect, tileKeyOf, tileRect, tilesCoveringCircle, walkMinutes,
} from "../../shared/geo";

const tileCenter = (key: string) => {
  const r = tileRect(key);
  return { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 };
};

describe("geo", () => {
  it("R1: ASEM 좌표의 격자 키는 '16672:45378'이다", () => {
    expect(tileKeyOf(ASEM)).toBe("16672:45378");
  });

  it("R1: tileRect는 키가 가리키는 격자 경계를 돌려준다", () => {
    const r = tileRect("16672:45378");
    expect(r.minLat).toBeCloseTo(16672 * TILE_LAT, 9);
    expect(r.maxLat).toBeCloseTo(16673 * TILE_LAT, 9);
    expect(r.minLng).toBeCloseTo(45378 * TILE_LNG, 9);
    expect(r.maxLng).toBeCloseTo(45379 * TILE_LNG, 9);
    expect(tileKeyOf(tileCenter("16672:45378"))).toBe("16672:45378");
  });

  it("R1: 모양이 틀린 격자 키는 NaN 사각형 대신 오류로 알린다 (NaN 사각형으로 카카오를 부르지 않게)", () => {
    for (const bad of ["", "1", "1:2:3", "a:b", "1.5:2", "1:", ":2", " 1:2", "1:2 ", "1e3:2", "NaN:1"]) {
      expect(() => tileRect(bad), JSON.stringify(bad)).toThrow(/tile key/);
    }
    expect(tileRect("-1:-2")).toEqual({ minLat: -TILE_LAT, maxLat: 0, minLng: -2 * TILE_LNG, maxLng: -TILE_LNG });
  });

  it("R1: 반경 0이면 중심이 속한 격자 하나만 덮는다", () => {
    expect(tilesCoveringCircle(ASEM, 0)).toEqual([tileKeyOf(ASEM)]);
  });

  it("R1: 격자 중심에서 반경 100m는 1개, 130m는 십자 5개, 180m는 3x3 9개 격자를 덮는다", () => {
    const c = tileCenter("16672:45378");
    expect(tilesCoveringCircle(c, 100)).toHaveLength(1);
    const five = tilesCoveringCircle(c, 130);
    expect(five).toHaveLength(5);
    expect(five).toEqual(expect.arrayContaining(["16672:45378", "16671:45378", "16673:45378", "16672:45377", "16672:45379"]));
    expect(tilesCoveringCircle(c, 180)).toHaveLength(9);
  });

  it("R1: 반경 1500m가 덮는 모든 격자는 원과 실제로 겹친다", () => {
    const keys = tilesCoveringCircle(ASEM, 1500);
    expect(keys.length).toBeGreaterThan(100);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) {
      const r = tileRect(k);
      const nearest = {
        lat: Math.min(Math.max(ASEM.lat, r.minLat), r.maxLat),
        lng: Math.min(Math.max(ASEM.lng, r.minLng), r.maxLng),
      };
      expect(haversine(ASEM, nearest)).toBeLessThanOrEqual(1500);
    }
  });

  it("infra: 하버사인 거리 — 위도 1도는 약 111,195m", () => {
    expect(haversine({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111195, -1);
    expect(haversine(ASEM, ASEM)).toBe(0);
  });

  it("infra: boundingBox는 반경을 모두 포함한다", () => {
    const b = boundingBox(ASEM, 700);
    expect(haversine(ASEM, { lat: b.maxLat, lng: ASEM.lng })).toBeGreaterThanOrEqual(699);
    expect(haversine(ASEM, { lat: ASEM.lat, lng: b.maxLng })).toBeGreaterThanOrEqual(699);
  });

  it("R2: splitRect는 사각형을 겹치지 않는 4개로 나눈다", () => {
    const r = { minLat: 0, minLng: 0, maxLat: 2, maxLng: 4 };
    expect(splitRect(r)).toEqual([
      { minLat: 0, minLng: 0, maxLat: 1, maxLng: 2 },
      { minLat: 0, minLng: 2, maxLat: 1, maxLng: 4 },
      { minLat: 1, minLng: 0, maxLat: 2, maxLng: 2 },
      { minLat: 1, minLng: 2, maxLat: 2, maxLng: 4 },
    ]);
  });

  it("R26: 도보 시간 = ceil(거리 × 1.3 / 70)", () => {
    expect(walkMinutes(0)).toBe(0);
    expect(walkMinutes(100)).toBe(2);
    expect(walkMinutes(700)).toBe(13);
    expect(walkMinutes(1200)).toBe(23);
  });
});
