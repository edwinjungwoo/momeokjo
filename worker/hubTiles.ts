import { PREWARM_RADIUS } from "../shared/constants";
import { tilesCoveringCircle } from "../shared/geo";
import { HUBS } from "../shared/hubs";

let cached: ReadonlySet<string> | null = null;

/** R11: Cron이 유지하는 격자 = 모든 거점의 PREWARM_RADIUS 격자 합집합 (isolate마다 한 번 계산) */
export function hubTileKeys(): ReadonlySet<string> {
  cached ??= new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS)));
  return cached;
}
