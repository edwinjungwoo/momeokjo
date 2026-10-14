import { secondLevel } from "../shared/category";
import { PREWARM_RADIUS } from "../shared/constants";
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
    pass: auditPassOf({ total: keys.length, collected: states.size, saturated }, coverage),
  };
}

/** R32 Q1(격자를 다 모았고 포화 없음)·Q2(상세 커버리지 95 % 이상) — auditArea와 R68 공개 확인(auditPass)이 같이 쓴다 */
export function auditPassOf(tiles: { total: number; collected: number; saturated: number }, coverage: number): { q1: boolean; q2: boolean } {
  return { q1: tiles.saturated === 0 && tiles.collected === tiles.total, q2: coverage >= 0.95 };
}

/** R68: 격자 수·포화 수 (격자 행만, 키마다 기본 키 1행) */
const AUDIT_TILES_SQL = `SELECT count(*) AS collected, count(CASE WHEN saturated = 1 THEN 1 END) AS saturated
  FROM tiles WHERE key IN (SELECT value FROM json_each(?))`;
/**
 * R68: 상세 미수집(places 행 없음)이 하나라도 있나 — 칸을 먼 칸부터 본다(CROSS JOIN 순서 고정). 채우는 중이면 Cron이 가까운 칸부터
 * 채우므로 먼 칸에서 일찍 멈춘다 (다 채웠으면 거점 가게를 한 번 다 읽는다)
 */
const AUDIT_MISSING_SQL = `SELECT EXISTS (
  SELECT 1 FROM json_each(?1) AS k CROSS JOIN tile_places tp ON tp.tile_key = k.value
    LEFT JOIN places p ON p.id = tp.place_id WHERE p.id IS NULL
) AS missing`;
/**
 * R68: auditArea와 같은 상세 숫자를 집계로 — 덮는 격자에 기록된 ID(중복 없이)마다 places를 기본 키로 한 번.
 * ok는 auditArea처럼 보이는 행(이름·좌표가 있는 행 — placesByIds의 SELECT_VISIBLE)만, failed·missing은 상태로 센다.
 * 장소 본문(JSON)을 Worker로 가져오지 않아 CPU는 결과 한 행뿐이다
 */
const AUDIT_DETAIL_SQL = `WITH ids AS (SELECT DISTINCT tp.place_id AS id FROM json_each(?1) AS k JOIN tile_places tp ON tp.tile_key = k.value)
SELECT count(*) AS places,
  count(CASE WHEN p.status = 'ok' AND p.name IS NOT NULL AND p.lat IS NOT NULL AND p.lng IS NOT NULL THEN 1 END) AS ok,
  count(CASE WHEN p.status = 'failed' THEN 1 END) AS failed,
  count(CASE WHEN p.id IS NULL THEN 1 END) AS missing
FROM ids LEFT JOIN places p ON p.id = ids.id`;

export type AuditTiles = { total: number; collected: number; saturated: number };
export type AuditDetail = { ok: number; failed: number; missing: number; coverage: number };

export async function auditTiles(db: D1Database, keys: readonly string[]): Promise<AuditTiles> {
  const r = await db.prepare(AUDIT_TILES_SQL).bind(JSON.stringify(keys)).first<{ collected: number; saturated: number }>();
  return { total: keys.length, collected: Number(r?.collected ?? 0), saturated: Number(r?.saturated ?? 0) };
}

/** keys는 먼 칸부터 주면 채우는 중에 일찍 멈춘다 */
export async function auditHasMissing(db: D1Database, keys: readonly string[]): Promise<boolean> {
  const r = await db.prepare(AUDIT_MISSING_SQL).bind(JSON.stringify(keys)).first<{ missing: number }>();
  return Number(r?.missing ?? 0) === 1;
}

export async function auditDetail(db: D1Database, keys: readonly string[]): Promise<{ places: number; detail: AuditDetail }> {
  const r = await db.prepare(AUDIT_DETAIL_SQL).bind(JSON.stringify(keys)).first<Record<string, number>>();
  const places = Number(r?.places ?? 0);
  const ok = Number(r?.ok ?? 0);
  return {
    places,
    detail: { ok, failed: Number(r?.failed ?? 0), missing: Number(r?.missing ?? 0), coverage: places === 0 ? 1 : ratio(ok, places) },
  };
}

/**
 * R68: auditArea의 Q1·Q2 판단만 가볍게 — 격자 집계 1번 + 상세 집계 1번 (auditArea는 장소 행을 90개씩 다 읽어 D1 호출 ~30번·CPU가 커서
 * Cron에 넣을 수 없다). 같은 정의라 숫자·판단이 같다 (테스트)
 */
export async function auditPass(
  db: D1Database, center: LatLng, radiusM = PREWARM_RADIUS,
): Promise<{ places: number; tiles: AuditTiles; detail: AuditDetail; pass: { q1: boolean; q2: boolean } }> {
  const keys = tilesCoveringCircle(center, radiusM);
  const tiles = await auditTiles(db, keys);
  const { places, detail } = await auditDetail(db, keys);
  return { places, tiles, detail, pass: auditPassOf(tiles, detail.coverage) };
}
