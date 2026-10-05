import { categoryGroup } from "../shared/category";
import { DETAIL_FAIL_TTL_MS, DETAIL_OK_TTL_MS, TILE_TTL_MS } from "../shared/constants";
import { haversine, tileRect, tilesCoveringCircle } from "../shared/geo";
import type { ApiDetail, CategoryGroup, LatLng, Place, PlaceDetail, PlaceSummary, Rect } from "../shared/types";

export type DetailMeta = { status: "ok" | "failed"; fetchedAt: number; reason: string | null } | null;
export type PlaceRow = { place: Place; detail: ApiDetail; meta: NonNullable<DetailMeta> };
export type TileState = { collectedAt: number; saturated: boolean };
export type TilePlaceState = { id: string; tileKey: string; meta: DetailMeta };

const CHUNK = 90;
const chunked = <T>(items: T[]): T[][] =>
  Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

export const placeUrl = (id: string) => `https://place.map.kakao.com/${id}`;

type DbRow = {
  id: string; status: string; name: string | null; category_name: string | null; category_group: string | null;
  lat: number | null; lng: number | null; address: string | null; phone: string | null; photo_url: string | null;
  rating: number | null; review_count: number | null; price: number | null;
  menus_json: string | null; hours_json: string | null; strengths_json: string | null; tags_json: string | null;
  bookable: number | null; fail_reason: string | null; fetched_at: number;
};

const SELECT_VISIBLE = `SELECT * FROM places WHERE name IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL`;

const metaOf = (status: string | null, fetchedAt: number | null, reason: string | null): DetailMeta =>
  status === null || fetchedAt === null ? null : { status: status === "ok" ? "ok" : "failed", fetchedAt, reason };

function toRow(r: DbRow): PlaceRow {
  return {
    place: {
      id: r.id,
      name: r.name as string,
      categoryName: r.category_name ?? "",
      group: (r.category_group ?? "etc") as CategoryGroup,
      lat: r.lat as number,
      lng: r.lng as number,
      address: r.address,
      phone: r.phone,
      photoUrl: r.photo_url ?? null,
      url: placeUrl(r.id),
    },
    detail: {
      rating: r.rating,
      reviewCount: r.review_count,
      price: r.price,
      menus: JSON.parse(r.menus_json ?? "[]"),
      hours: r.hours_json ? JSON.parse(r.hours_json) : null,
      strengths: JSON.parse(r.strengths_json ?? "[]"),
      tags: JSON.parse(r.tags_json ?? "[]"),
      bookable: r.bookable === null ? null : r.bookable === 1,
      fetchedAt: r.fetched_at,
    },
    meta: metaOf(r.status, r.fetched_at, r.fail_reason) as NonNullable<DetailMeta>,
  };
}

const TILE_UPSERT = `INSERT INTO tiles (key, collected_at, place_count, saturated) VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET collected_at = excluded.collected_at, place_count = excluded.place_count,
    saturated = excluded.saturated`;

export async function markTile(db: D1Database, key: string, now: number, placeCount: number, saturated: boolean) {
  await db.prepare(TILE_UPSERT).bind(key, now, placeCount, saturated ? 1 : 0).run();
}

/** 로컬 API 결과 중 장소 ID만 기록한다 (카카오 정책: 로컬 API 응답 저장 금지, ID 기록은 허용) */
export async function replaceTilePlaces(
  db: D1Database, key: string, ids: string[], now: number, saturated: boolean,
): Promise<void> {
  const unique = [...new Set(ids)];
  const insert = db.prepare("INSERT INTO tile_places (tile_key, place_id) VALUES (?, ?)");
  await db.batch([
    db.prepare("DELETE FROM tile_places WHERE tile_key = ?").bind(key),
    ...unique.map((id) => insert.bind(key, id)),
    db.prepare(TILE_UPSERT).bind(key, now, unique.length, saturated ? 1 : 0),
  ]);
}

export async function getTiles(db: D1Database, keys: string[]): Promise<Map<string, TileState>> {
  const out = new Map<string, TileState>();
  for (const chunk of chunked(keys)) {
    const r = await db
      .prepare(`SELECT key, collected_at, saturated FROM tiles WHERE key IN (${marks(chunk.length)})`)
      .bind(...chunk)
      .all<{ key: string; collected_at: number; saturated: number }>();
    for (const t of r.results) out.set(t.key, { collectedAt: t.collected_at, saturated: t.saturated === 1 });
  }
  return out;
}

export function isTileDue(state: TileState | undefined, now: number): boolean {
  return !state || now - state.collectedAt >= TILE_TTL_MS;
}

export function isDetailDue(meta: DetailMeta, now: number): boolean {
  if (!meta) return true;
  return now - meta.fetchedAt >= (meta.status === "ok" ? DETAIL_OK_TTL_MS : DETAIL_FAIL_TTL_MS);
}

export async function tilePlaceStates(db: D1Database, keys: string[]): Promise<TilePlaceState[]> {
  const out: TilePlaceState[] = [];
  for (const chunk of chunked(keys)) {
    const r = await db
      .prepare(
        `SELECT tp.place_id AS id, tp.tile_key AS tile_key, p.status AS status, p.fetched_at AS fetched_at,
           p.fail_reason AS fail_reason
         FROM tile_places tp LEFT JOIN places p ON p.id = tp.place_id
         WHERE tp.tile_key IN (${marks(chunk.length)})`,
      )
      .bind(...chunk)
      .all<{ id: string; tile_key: string; status: string | null; fetched_at: number | null; fail_reason: string | null }>();
    for (const x of r.results) out.push({ id: x.id, tileKey: x.tile_key, meta: metaOf(x.status, x.fetched_at, x.fail_reason) });
  }
  return out;
}

export async function idsNeedingDetail(
  db: D1Database, center: LatLng, radiusM: number, now: number, limit?: number,
): Promise<string[]> {
  const nearest = new Map<string, number>();
  for (const t of await tilePlaceStates(db, tilesCoveringCircle(center, radiusM))) {
    if (!isDetailDue(t.meta, now)) continue;
    const r = tileRect(t.tileKey);
    const d = haversine(center, { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 });
    const prev = nearest.get(t.id);
    if (prev === undefined || d < prev) nearest.set(t.id, d);
  }
  const ids = [...nearest.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
  return limit === undefined ? ids : ids.slice(0, limit);
}

export async function countNeedingDetail(db: D1Database, center: LatLng, radiusM: number, now: number): Promise<number> {
  return (await idsNeedingDetail(db, center, radiusM, now)).length;
}

export async function countUnfetched(db: D1Database, keys: string[]): Promise<number> {
  return new Set((await tilePlaceStates(db, keys)).filter((t) => t.meta === null).map((t) => t.id)).size;
}

export async function placesInBox(db: D1Database, box: Rect): Promise<PlaceRow[]> {
  const r = await db
    .prepare(`${SELECT_VISIBLE} AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`)
    .bind(box.minLat, box.maxLat, box.minLng, box.maxLng)
    .all<DbRow>();
  return r.results.map(toRow);
}

export async function placesByIds(db: D1Database, ids: string[]): Promise<PlaceRow[]> {
  const out: PlaceRow[] = [];
  for (const chunk of chunked(ids)) {
    const r = await db.prepare(`${SELECT_VISIBLE} AND id IN (${marks(chunk.length)})`).bind(...chunk).all<DbRow>();
    out.push(...r.results.map(toRow));
  }
  return out;
}

export async function placeById(db: D1Database, id: string): Promise<PlaceRow | null> {
  const r = await db.prepare(`${SELECT_VISIBLE} AND id = ?`).bind(id).first<DbRow>();
  return r ? toRow(r) : null;
}

export async function getMeta(db: D1Database, id: string): Promise<DetailMeta> {
  const r = await db
    .prepare("SELECT status, fetched_at, fail_reason FROM places WHERE id = ?")
    .bind(id)
    .first<{ status: string; fetched_at: number; fail_reason: string | null }>();
  return r ? metaOf(r.status, r.fetched_at, r.fail_reason) : null;
}

export async function saveDetail(
  db: D1Database, id: string, s: PlaceSummary, d: PlaceDetail, now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO places (id, status, name, category_name, category_group, lat, lng, address, phone, photo_url,
         rating, review_count, price, menus_json, hours_json, strengths_json, tags_json, bookable, fail_reason, fetched_at)
       VALUES (?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(
      id, s.name, s.categoryName, categoryGroup(s.categoryName), s.lat, s.lng, s.address, s.phone, s.photoUrl,
      d.rating, d.reviewCount, d.price, JSON.stringify(d.menus), d.hours ? JSON.stringify(d.hours) : null,
      JSON.stringify(d.strengths), JSON.stringify(d.tags), d.bookable === null ? null : d.bookable ? 1 : 0, now,
    )
    .run();
}

export async function saveDetailFailure(db: D1Database, id: string, reason: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO places (id, status, fail_reason, fetched_at) VALUES (?, 'failed', ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'failed', fail_reason = excluded.fail_reason, fetched_at = excluded.fetched_at`,
    )
    .bind(id, reason, now)
    .run();
}
