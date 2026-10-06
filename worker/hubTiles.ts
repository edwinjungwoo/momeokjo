import { PREWARM_RADIUS } from "../shared/constants";
import { tilesCoveringCircle } from "../shared/geo";
import { HUBS } from "../shared/hubs";

let cached: ReadonlySet<string> | null = null;

/** R11: Cron이 유지하는 격자 = 모든 거점의 PREWARM_RADIUS 격자 합집합 (isolate마다 한 번 계산) */
export function hubTileKeys(): ReadonlySet<string> {
  cached ??= new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)));
  return cached;
}

let byTile: ReadonlyMap<string, string[]> | null = null;

/** R56: 이 격자를 PREWARM_RADIUS 격자로 덮는 거점 id들 (없으면 빈 배열, isolate마다 한 번 계산) */
export function hubsOfTile(key: string): string[] {
  if (!byTile) {
    const m = new Map<string, string[]>();
    for (const h of HUBS) for (const k of tilesCoveringCircle(h, PREWARM_RADIUS)) m.set(k, [...(m.get(k) ?? []), h.id]);
    byTile = m;
  }
  return byTile.get(key) ?? [];
}
