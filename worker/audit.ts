import { secondLevel } from "../shared/category";
import { tilesCoveringCircle } from "../shared/geo";
import type { LatLng } from "../shared/types";
import { getTiles, placesByIds, tilePlaceStates, type DetailMeta } from "./repo";

export type AuditReport = {
  center: LatLng;
  radius: number;
  places: number;
  byGroup: Record<string, number>;
  etcSecondLevels: Record<string, number>;
  tiles: { total: number; collected: number; saturated: number };
  detail: { ok: number; failed: number; missing: number; coverage: number };
  nullRates: { rating: number; price: number; hours: number };
  failures: { id: string; name: string | null; reason: string | null }[];
  invalidCoords: number;
  duplicateGroups: number;
  pass: { q1: boolean; q2: boolean };
};

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};
const ratio = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 10000) / 10000);

export async function auditArea(db: D1Database, center: LatLng, radiusM: number): Promise<AuditReport> {
  const keys = tilesCoveringCircle(center, radiusM);
  const states = await getTiles(db, keys);
  const saturated = [...states.values()].filter((s) => s.saturated).length;

  const metaById = new Map<string, DetailMeta>();
  for (const t of await tilePlaceStates(db, keys)) metaById.set(t.id, t.meta);
  const ids = [...metaById.keys()];
  const rows = await placesByIds(db, ids);
  const rowById = new Map(rows.map((r) => [r.place.id, r]));

  const byGroup: Record<string, number> = {};
  const etcSecondLevels: Record<string, number> = {};
  const dupKeys: Record<string, number> = {};
  let invalidCoords = 0;
  for (const r of rows) {
    bump(byGroup, r.place.group);
    if (r.place.group === "etc") bump(etcSecondLevels, secondLevel(r.place.categoryName) || "(없음)");
    bump(dupKeys, `${r.place.name}|${r.place.lat.toFixed(5)}|${r.place.lng.toFixed(5)}`);
    if (r.place.lat < 33 || r.place.lat > 39 || r.place.lng < 124 || r.place.lng > 132) invalidCoords += 1;
  }

  const metas = [...metaById.entries()];
  const okRows = rows.filter((r) => r.meta.status === "ok");
  const failedIds = metas.filter(([, m]) => m?.status === "failed").map(([id]) => id);
  const missing = metas.filter(([, m]) => m === null).length;
  const coverage = ids.length === 0 ? 1 : ratio(okRows.length, ids.length);

  return {
    center,
    radius: radiusM,
    places: ids.length,
    byGroup,
    etcSecondLevels,
    tiles: { total: keys.length, collected: states.size, saturated },
    detail: { ok: okRows.length, failed: failedIds.length, missing, coverage },
    nullRates: {
      rating: ratio(okRows.filter((r) => r.detail.rating === null).length, okRows.length),
      price: ratio(okRows.filter((r) => r.detail.price === null).length, okRows.length),
      hours: ratio(okRows.filter((r) => r.detail.hours === null).length, okRows.length),
    },
    failures: failedIds.slice(0, 50).map((id) => ({
      id,
      name: rowById.get(id)?.place.name ?? null,
      reason: metaById.get(id)?.reason ?? null,
    })),
    invalidCoords,
    duplicateGroups: Object.values(dupKeys).filter((n) => n > 1).length,
    pass: { q1: saturated === 0 && states.size === keys.length, q2: coverage >= 0.95 },
  };
}
