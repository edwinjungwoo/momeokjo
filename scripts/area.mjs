import { DEFAULT_HUB_ID, HUBS } from "../shared/hubs.ts";

/**
 * 스크립트 인자 → 대상 지역. 기본은 기본 거점(봉은사역) 반경 1000m.
 *   node scripts/warm.mjs                 # 기본 거점
 *   node scripts/warm.mjs --hub ddp       # shared/hubs.ts의 거점 id
 *   node scripts/warm.mjs --all           # 모든 거점 (warm만)
 *   node scripts/warm.mjs 37.51 127.06 800
 */
export function areasFromArgs(argv, defaultRadius = "1000") {
  const args = [...argv];
  const toArea = (h, radius = defaultRadius) => ({ label: h.name, lat: String(h.lat), lng: String(h.lng), radius });
  if (args[0] === "--all") return HUBS.map((h) => toArea(h, args[1]));
  if (args[0] === "--hub") {
    const hub = HUBS.find((h) => h.id === args[1]);
    if (!hub) {
      console.error(`모르는 거점이에요: ${args[1]} (가능: ${HUBS.map((h) => h.id).join(", ")})`);
      process.exit(1);
    }
    return [toArea(hub, args[2])];
  }
  if (args.length >= 2) return [{ label: `${args[0]}, ${args[1]}`, lat: args[0], lng: args[1], radius: args[2] ?? defaultRadius }];
  return [toArea(HUBS.find((h) => h.id === DEFAULT_HUB_ID))];
}
