import type { Menu } from "./types";

const MIN = 5000;
const MAX = 30000;

export function representativePrice(menus: Menu[]): number | null {
  const v = menus.map((m) => m.price).filter((p) => p >= MIN && p <= MAX).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return Math.round(median / 100) * 100;
}
