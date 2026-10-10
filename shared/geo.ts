import { TILE_LAT, TILE_LNG } from "./constants";
import type { LatLng, Rect } from "./types";

const EARTH_R = 6371008.8;
const M_PER_DEG_LAT = 111320;
const rad = (d: number) => (d * Math.PI) / 180;

export function tileKeyOf(p: LatLng): string {
  return `${Math.floor(p.lat / TILE_LAT)}:${Math.floor(p.lng / TILE_LNG)}`;
}

const rectOf = (i: number, j: number): Rect =>
  ({ minLat: i * TILE_LAT, maxLat: (i + 1) * TILE_LAT, minLng: j * TILE_LNG, maxLng: (j + 1) * TILE_LNG });

const TILE_KEY = /^(-?\d+):(-?\d+)$/;

/** 격자 키("i:j", 정수 둘)의 경계. 모양이 틀린 키는 NaN 사각형 대신 오류 — 그 사각형으로 카카오를 부르지 않게 */
export function tileRect(key: string): Rect {
  const m = TILE_KEY.exec(key);
  if (!m) throw new Error(`invalid tile key: ${JSON.stringify(key)}`);
  return rectOf(Number(m[1]), Number(m[2]));
}

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function boundingBox(c: LatLng, radiusM: number): Rect {
  const dLat = (radiusM / M_PER_DEG_LAT) * 1.01;
  const dLng = (radiusM / (M_PER_DEG_LAT * Math.cos(rad(c.lat)))) * 1.01;
  return { minLat: c.lat - dLat, maxLat: c.lat + dLat, minLng: c.lng - dLng, maxLng: c.lng + dLng };
}

export function tilesCoveringCircle(c: LatLng, radiusM: number): string[] {
  const box = boundingBox(c, radiusM);
  const i0 = Math.floor(box.minLat / TILE_LAT);
  const i1 = Math.floor(box.maxLat / TILE_LAT);
  const j0 = Math.floor(box.minLng / TILE_LNG);
  const j1 = Math.floor(box.maxLng / TILE_LNG);
  const keys: string[] = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const key = `${i}:${j}`;
      const r = rectOf(i, j);
      const nearest = {
        lat: Math.min(Math.max(c.lat, r.minLat), r.maxLat),
        lng: Math.min(Math.max(c.lng, r.minLng), r.maxLng),
      };
      if (haversine(c, nearest) <= radiusM) keys.push(key);
    }
  }
  return keys;
}

export function splitRect(r: Rect): [Rect, Rect, Rect, Rect] {
  const midLat = (r.minLat + r.maxLat) / 2;
  const midLng = (r.minLng + r.maxLng) / 2;
  return [
    { minLat: r.minLat, minLng: r.minLng, maxLat: midLat, maxLng: midLng },
    { minLat: r.minLat, minLng: midLng, maxLat: midLat, maxLng: r.maxLng },
    { minLat: midLat, minLng: r.minLng, maxLat: r.maxLat, maxLng: midLng },
    { minLat: midLat, minLng: midLng, maxLat: r.maxLat, maxLng: r.maxLng },
  ];
}

export function walkMinutes(distanceM: number): number {
  return Math.ceil((distanceM * 1.3) / 70);
}
