import { PREWARM_RADIUS } from "../shared/constants";
import { tilesCoveringCircle } from "../shared/geo";
import { HUBS } from "../shared/hubs";
import type { LatLng } from "../shared/types";

const byCenter = new Map<string, readonly string[]>();

/**
 * 거점(기준점) 하나의 PREWARM_RADIUS 격자 = tilesCoveringCircle(hub, PREWARM_RADIUS) — 좌표마다 isolate에서 한 번 계산하고
 * 같은 배열을 돌려준다(바꿀 수 없게 얼린다). Task 57: Cron 한 실행이 격자 합집합·갱신 시작 표·칸 → 거점·완료 후보마다
 * 14곳 × ~100칸 haversine을 서너 번 다시 계산했다 (새 isolate에서 실행마다 ~0.5ms)
 */
export function hubTiles(hub: LatLng): readonly string[] {
  const key = `${hub.lat},${hub.lng}`;
  let tiles = byCenter.get(key);
  if (!tiles) byCenter.set(key, (tiles = Object.freeze(tilesCoveringCircle(hub, PREWARM_RADIUS))));
  return tiles;
}

let cached: ReadonlySet<string> | null = null;

/** R11: Cron이 유지하는 격자 = 모든 거점의 PREWARM_RADIUS 격자 합집합 (isolate마다 한 번 계산) */
export function hubTileKeys(): ReadonlySet<string> {
  cached ??= new Set(HUBS.flatMap((h) => hubTiles(h)));
  return cached;
}

let byTile: ReadonlyMap<string, string[]> | null = null;

/** R56: 이 격자를 PREWARM_RADIUS 격자로 덮는 거점 id들 (없으면 빈 배열, isolate마다 한 번 계산) */
export function hubsOfTile(key: string): string[] {
  if (!byTile) {
    const m = new Map<string, string[]>();
    for (const h of HUBS) for (const k of hubTiles(h)) m.set(k, [...(m.get(k) ?? []), h.id]);
    byTile = m;
  }
  return byTile.get(key) ?? [];
}
