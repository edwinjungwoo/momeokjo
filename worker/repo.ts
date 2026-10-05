import { categoryGroup } from "../shared/category";
import {
  DETAIL_FAIL_TTL_MS, DETAIL_FREEZE_AFTER_BLOCKS, DETAIL_FREEZE_MS, DETAIL_JITTER_MS, DETAIL_OK_TTL_MS,
  PLACE_BLOCK_COOLDOWN_MS, TILE_TTL_MS,
} from "../shared/constants";
import { kstDay } from "../shared/kst";
import { haversine, tileRect, tilesCoveringCircle } from "../shared/geo";
import type { CategoryGroup, LatLng, Place, PlaceDetail, PlaceSummary, Rect, StoredDetail } from "../shared/types";
import { listItemJson } from "./present";

export type DetailMeta = { status: "ok" | "failed"; fetchedAt: number; reason: string | null } | null;
export type PlaceRow = { place: Place; detail: StoredDetail; meta: NonNullable<DetailMeta> };
export type TileState = { collectedAt: number; saturated: boolean };
export type TilePlaceState = { id: string; tileKey: string; meta: DetailMeta };

const CHUNK = 90;
const META_UPSERT = "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
const BLOCKED_KEY = "place_blocked_until";
const TILES_CHANGED_KEY = "tiles_changed_at";
const UNFETCHED_CLEARED_KEY = "unfetched_cleared_at";
const DETAIL_MODE_KEY = "detail_mode";
const BLOCK_COUNT_PREFIX = "block_count:";
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
  /** 0005: 목록 원소 조각 (예전 행은 NULL) */
  list_json?: string | null;
};

const SELECT_VISIBLE = `SELECT * FROM places WHERE name IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL`;

const metaOf = (status: string | null, fetchedAt: number | null, reason: string | null): DetailMeta =>
  status === null || fetchedAt === null ? null : { status: status === "ok" ? "ok" : "failed", fetchedAt, reason };

/**
 * QA D-8: 저장된 JSON 열이 깨졌거나 모양이 틀려도 목록 전체가 500이 되지 않게 그 필드만 빈 값으로 읽는다.
 * 깨진 행은 Workers 로그에서 보이게 행 id와 열 이름만 남긴다 (멀쩡한 행은 아무것도 하지 않는다)
 */
function readJson<T>(id: string, col: string, raw: string | null, fallback: T, ok: (v: unknown) => boolean): T {
  if (!raw) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    if (ok(v)) return v as T;
  } catch {
    /* 아래에서 남긴다 */
  }
  warnCorruptOnce(id, col);
  return fallback;
}

/** 깨진 열 경고를 기억하는 개수 상한 (넘으면 비우고 다시 센다) */
export const CORRUPT_WARN_CAP = 200;
const corruptWarned = new Set<string>();

/** 목록 요청마다 같은 깨진 행이 로그를 채우지 않게, 행 id·열 이름마다 isolate당 한 번만 남긴다 */
export function warnCorruptOnce(id: string, col: string) {
  const key = `${id}:${col}`;
  if (corruptWarned.has(key)) return;
  if (corruptWarned.size >= CORRUPT_WARN_CAP) corruptWarned.clear();
  corruptWarned.add(key);
  console.warn("corrupt json column", { id, col });
}

/** 테스트용: 이미 남긴 경고 기억을 비운다 */
export function resetCorruptWarnings() {
  corruptWarned.clear();
}
const isPlainObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

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
      menus: readJson(r.id, "menus_json", r.menus_json, [], Array.isArray),
      hours: readJson(r.id, "hours_json", r.hours_json, null, isPlainObject),
      strengths: readJson(r.id, "strengths_json", r.strengths_json, [], Array.isArray),
      tags: readJson(r.id, "tags_json", r.tags_json, [], Array.isArray),
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

/**
 * 로컬 API 결과 중 장소 ID만 기록한다 (카카오 정책: 로컬 API 응답 저장 금지, ID 기록은 허용).
 * D1 쓰기를 아끼려고 지금 기록된 ID를 읽어서 바뀐 것만 쓴다: 빠진 ID만 DELETE, 새 ID만 INSERT OR IGNORE (각각 한 문장).
 * 격자 상태(수집 시각)는 언제나 갱신하고, ID가 바뀌었을 때만 tiles_changed_at을 올린다 (Cron의 미수집 확인을 깨우는 값).
 */
export async function replaceTilePlaces(
  db: D1Database, key: string, ids: string[], now: number, saturated: boolean,
): Promise<void> {
  const unique = [...new Set(ids)];
  const cur = await db.prepare("SELECT place_id FROM tile_places WHERE tile_key = ?").bind(key).all<{ place_id: string }>();
  const current = new Set(cur.results.map((r) => r.place_id));
  const next = new Set(unique);
  const added = unique.filter((id) => !current.has(id));
  const removed = [...current].filter((id) => !next.has(id));
  const stmts: D1PreparedStatement[] = [];
  if (removed.length > 0) {
    stmts.push(
      db
        .prepare("DELETE FROM tile_places WHERE tile_key = ? AND place_id IN (SELECT value FROM json_each(?))")
        .bind(key, JSON.stringify(removed)),
    );
  }
  if (added.length > 0) {
    stmts.push(
      db
        .prepare("INSERT OR IGNORE INTO tile_places (tile_key, place_id) SELECT ?, value FROM json_each(?)")
        .bind(key, JSON.stringify(added)),
    );
  }
  stmts.push(db.prepare(TILE_UPSERT).bind(key, now, unique.length, saturated ? 1 : 0));
  if (stmts.length > 1) stmts.push(db.prepare(META_UPSERT).bind(TILES_CHANGED_KEY, String(now)));
  await db.batch(stmts);
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

/** id로 정해지는 0 ≤ jitter < 24시간 (FNV-1a 32비트 + murmur3 마무리 섞기 — 연속된 id도 고르게 흩어진다) */
export function detailJitterMs(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  return Math.floor((h / 0x1_0000_0000) * DETAIL_JITTER_MS);
}

export function isDetailDue(meta: DetailMeta, now: number, id: string): boolean {
  if (!meta) return true;
  const ttl = meta.status === "ok" ? DETAIL_OK_TTL_MS + detailJitterMs(id) : DETAIL_FAIL_TTL_MS;
  return now - meta.fetchedAt >= ttl;
}

/** due: 상세가 없거나 만료된 ID (Cron, warm) / unfetched: 한 번도 가져오지 않은 ID만 (요청 시점 보충) */
export type DetailScope = "due" | "unfetched";

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
  db: D1Database, center: LatLng, radiusM: number, now: number, limit?: number, scope: DetailScope = "due",
): Promise<string[]> {
  return pickDetailIds(await tilePlaceStates(db, tilesCoveringCircle(center, radiusM)), center, now, limit, scope);
}

/**
 * 이미 읽어 둔 격자-장소 상태에서 보충할 ID를 고른다 (ID 중복 제거).
 * 격자 중심이 가장 가까운 기준점(여러 거점이면 그중 가까운 곳)에 가까운 순, 같으면 id순.
 */
export function pickDetailIds(
  states: TilePlaceState[], center: LatLng | LatLng[], now: number, limit?: number, scope: DetailScope = "due",
): string[] {
  const centers = Array.isArray(center) ? center : [center];
  const nearest = new Map<string, number>();
  for (const t of states) {
    if (scope === "unfetched" ? t.meta !== null : !isDetailDue(t.meta, now, t.id)) continue;
    const r = tileRect(t.tileKey);
    const mid = { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 };
    const d = Math.min(...centers.map((c) => haversine(c, mid)));
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
  return countUnfetchedIn(await tilePlaceStates(db, keys));
}

export const countUnfetchedIn = (states: TilePlaceState[]) =>
  new Set(states.filter((t) => t.meta === null).map((t) => t.id)).size;

/** Cron 만료 후보를 상태(ok/failed)마다 이만큼까지만 읽는다 (한 실행이 갱신하는 건 DETAIL_BATCH_SIZE곳뿐) */
export const EXPIRED_SCAN_LIMIT = 300;
/**
 * (status, fetched_at) 인덱스를 오래된 순으로 범위만 읽는다. 격자는 행마다 place_id 인덱스로 붙인다.
 * 바인드: status, from(포함), before(포함), limit
 */
export const EXPIRED_SCAN_SQL = `SELECT p.id AS id, p.status AS status, p.fetched_at AS fetched_at, p.fail_reason AS fail_reason,
    tp.tile_key AS tile_key
  FROM places p INDEXED BY idx_places_status_fetched_at LEFT JOIN tile_places tp ON tp.place_id = p.id
  WHERE p.status = ? AND p.fetched_at >= ? AND p.fetched_at <= ?
  ORDER BY p.fetched_at LIMIT ?`;
const EXPIRED_FROM_PREFIX = "expired_from:";
type ScanCursor = { from: number; at: number };

function parseCursor(raw: string | undefined): ScanCursor | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { from?: unknown; at?: unknown };
    return typeof o.from === "number" && typeof o.at === "number" ? { from: o.from, at: o.at } : null;
  } catch {
    return null;
  }
}

/**
 * Cron용(R11): 주어진 격자(= 모든 거점의 PREWARM_RADIUS 격자)의 장소 중 만료됐을 수 있는 것.
 * ok는 지터를 빼고(가장 이른 만료 시각) 고르므로 실제 만료 여부는 isDetailDue로 다시 확인한다.
 *
 * R38 읽기 예산: 상태마다 (status, fetched_at) 인덱스를 오래된 순으로 EXPIRED_SCAN_LIMIT행까지만 읽는다.
 * 거점 밖 행(예전 warm의 ASEM 1500m 고리, 격자에 없는 단건 조회)은 갱신되지 않아 늘 인덱스 맨 앞에 남으므로,
 * 상태마다 "여기부터 읽는다" 커서(meta expired_from:{status})를 둔다 — 첫 거점 행의 fetched_at,
 * 거점 행이 없었으면 지나간 마지막 행(다 읽었으면 before). 그 앞에는 거점 행이 없으니 다음 실행은 건너뛴다.
 * 거점 행은 갱신되면 fetched_at이 앞으로 가므로 커서 앞에 새로 생기지 않는다 — 격자 ID가 바뀌었을 때만
 * (오래된 행이 거점 격자에 새로 들어왔을 수 있다) 처음부터 다시 읽는다. 격자 집합이 늘 같은 Cron만 부른다.
 */
export async function expiredDetailStates(db: D1Database, keys: string[], now: number): Promise<TilePlaceState[]> {
  const wanted = new Set(keys);
  const changedAt = await tilesChangedAt(db);
  const statuses = [
    ["ok", now - DETAIL_OK_TTL_MS],
    ["failed", now - DETAIL_FAIL_TTL_MS],
  ] as const;
  const saved = await db
    .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
    .bind(...statuses.map(([st]) => EXPIRED_FROM_PREFIX + st))
    .all<{ key: string; value: string }>();
  const out: TilePlaceState[] = [];
  const writes: D1PreparedStatement[] = [];
  for (const [status, before] of statuses) {
    const key = EXPIRED_FROM_PREFIX + status;
    const cursor = parseCursor(saved.results.find((x) => x.key === key)?.value);
    const reset = cursor === null || changedAt > cursor.at;
    const from = reset ? 0 : cursor.from;
    const r = await db
      .prepare(EXPIRED_SCAN_SQL)
      .bind(status, from, before, EXPIRED_SCAN_LIMIT)
      .all<{ id: string; status: string; fetched_at: number; fail_reason: string | null; tile_key: string | null }>();
    let next: number | null = null;
    for (const x of r.results) {
      if (x.tile_key === null || !wanted.has(x.tile_key)) continue;
      next ??= x.fetched_at;
      out.push({ id: x.id, tileKey: x.tile_key, meta: metaOf(x.status, x.fetched_at, x.fail_reason) });
    }
    if (next === null) next = r.results.length >= EXPIRED_SCAN_LIMIT ? r.results[r.results.length - 1].fetched_at : Math.max(from, before);
    if (reset || next !== cursor.from) {
      writes.push(db.prepare(META_UPSERT).bind(key, JSON.stringify({ from: next, at: now })));
    }
  }
  if (writes.length > 0) await db.batch(writes);
  return out;
}

/** 주어진 격자에 기록됐지만 상세를 한 번도 가져오지 않은 장소 */
export async function unfetchedStates(db: D1Database, keys: string[]): Promise<TilePlaceState[]> {
  const out: TilePlaceState[] = [];
  for (const chunk of chunked(keys)) {
    const r = await db
      .prepare(
        `SELECT tp.place_id AS id, tp.tile_key AS tile_key FROM tile_places tp
         WHERE tp.tile_key IN (${marks(chunk.length)}) AND NOT EXISTS (SELECT 1 FROM places p WHERE p.id = tp.place_id)`,
      )
      .bind(...chunk)
      .all<{ id: string; tile_key: string }>();
    for (const x of r.results) out.push({ id: x.id, tileKey: x.tile_key, meta: null });
  }
  return out;
}

/**
 * 목록용: 격자에 기록된 가게만 (공유 링크 단건 조회로만 저장된 가게는 빠진다).
 * 격자 ID 집합(inTiles)을 이미 읽었으면 넘겨서 행마다 하는 EXISTS 조회를 아낀다.
 */
export async function placesInBox(db: D1Database, box: Rect, inTiles?: ReadonlySet<string>): Promise<PlaceRow[]> {
  const exists = inTiles ? "" : " AND EXISTS (SELECT 1 FROM tile_places tp WHERE tp.place_id = places.id)";
  const r = await db
    .prepare(`${SELECT_VISIBLE} AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?${exists}`)
    .bind(box.minLat, box.maxLat, box.minLng, box.maxLng)
    .all<DbRow>();
  const rows = inTiles ? r.results.filter((x) => inTiles.has(x.id)) : r.results;
  return rows.map(toRow);
}

/** R12 목록용 행: 거리·필터·detailsNewestAt에 쓰는 값과 목록 원소 조각(json) */
export type ListRow = { id: string; lat: number; lng: number; group: CategoryGroup; status: "ok" | "failed"; fetchedAt: number; json: string };

/** list_json이 있으면 무거운 열(메뉴·영업시간·강점·태그 JSON 등)은 받지 않는다 — D1 결과 크기와 Worker CPU를 아낀다 */
const heavy = (col: string) => `CASE WHEN list_json IS NULL THEN ${col} END AS ${col}`;
const LIST_SELECT = `SELECT id, status, name, category_name, category_group, lat, lng, fetched_at, list_json,
  ${["address", "phone", "photo_url", "rating", "review_count", "price", "menus_json", "hours_json", "strengths_json", "tags_json", "bookable", "fail_reason"].map(heavy).join(", ")}
  FROM places WHERE name IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL`;

/**
 * R12 목록: placesInBox와 같은 행을 고르되, 미리 만든 목록 원소 조각(list_json)을 그대로 쓴다.
 * 조각이 없는 예전 행(0005 전)만 열에서 만든다 (toRow → listItemJson, 결과는 같다).
 */
export async function listRowsInBox(db: D1Database, box: Rect, inTiles: ReadonlySet<string>): Promise<ListRow[]> {
  const r = await db
    .prepare(`${LIST_SELECT} AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`)
    .bind(box.minLat, box.maxLat, box.minLng, box.maxLng)
    .all<DbRow>();
  const out: ListRow[] = [];
  for (const x of r.results) {
    if (!inTiles.has(x.id)) continue;
    out.push({
      id: x.id,
      lat: x.lat as number,
      lng: x.lng as number,
      group: (x.category_group ?? "etc") as CategoryGroup,
      status: x.status === "ok" ? "ok" : "failed",
      fetchedAt: x.fetched_at,
      json: x.list_json ?? listItemJson(toRow(x)),
    });
  }
  return out;
}

/** Cron이 한 번에 채우는 list_json 수 (쓰기 ≤ 200행/실행) */
export const LIST_BACKFILL_LIMIT = 200;
const LIST_BACKFILL_KEY = "list_json_backfill";
const LIST_BACKFILL_DONE = "done";

/**
 * 0005 전에 저장된 행의 list_json을 rowid 순으로 LIST_BACKFILL_LIMIT행씩 채운다. 채운 수를 돌려준다.
 * 커서(meta list_json_backfill = 마지막 rowid)로 이어 읽어서 실행마다 places를 처음부터 훑지 않고,
 * 끝까지 읽으면 "done"을 남겨 그 뒤로는 meta 1행만 읽는다 (새 행은 saveDetail이 처음부터 채운다).
 * 그 사이 상세가 다시 저장된 행은 건드리지 않는다 (fetched_at이 같고 아직 NULL일 때만 쓴다).
 */
export async function backfillListJson(db: D1Database): Promise<number> {
  const cur = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(LIST_BACKFILL_KEY).first<{ value: string }>();
  if (cur?.value === LIST_BACKFILL_DONE) return 0;
  const after = Number(cur?.value ?? 0) || 0;
  const r = await db
    .prepare("SELECT rowid AS rid, * FROM places WHERE rowid > ? ORDER BY rowid LIMIT ?")
    .bind(after, LIST_BACKFILL_LIMIT)
    .all<DbRow & { rid: number }>();
  const fill = r.results
    .filter((x) => !x.list_json && x.name !== null && x.lat !== null && x.lng !== null)
    .map((x) => [x.id, x.fetched_at, listItemJson(toRow(x))] as const);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < fill.length; i += 100) {
    stmts.push(
      db
        .prepare(
          `UPDATE places SET list_json = json_extract(u.value, '$[2]') FROM json_each(?) AS u
           WHERE places.id = json_extract(u.value, '$[0]') AND places.fetched_at = json_extract(u.value, '$[1]')
             AND places.list_json IS NULL`,
        )
        .bind(JSON.stringify(fill.slice(i, i + 100))),
    );
  }
  const last = r.results[r.results.length - 1]?.rid;
  const next = r.results.length < LIST_BACKFILL_LIMIT ? LIST_BACKFILL_DONE : String(last);
  stmts.push(db.prepare(META_UPSERT).bind(LIST_BACKFILL_KEY, next));
  await db.batch(stmts);
  return fill.length;
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

/** 주어진 격자(보통 거점 격자) 중 하나에 기록된 ID인가 (R13: 거점 격자 밖 ID는 저장하지 않는다) */
export async function isInTiles(db: D1Database, id: string, keys: ReadonlySet<string>): Promise<boolean> {
  const r = await db.prepare("SELECT tile_key FROM tile_places WHERE place_id = ?").bind(id).all<{ tile_key: string }>();
  return r.results.some((x) => keys.has(x.tile_key));
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
         rating, review_count, price, menus_json, hours_json, strengths_json, tags_json, bookable, fail_reason, fetched_at,
         list_json)
       VALUES (?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .bind(
      id, s.name, s.categoryName, categoryGroup(s.categoryName), s.lat, s.lng, s.address, s.phone, s.photoUrl,
      d.rating, d.reviewCount, d.price, JSON.stringify(d.menus), d.hours ? JSON.stringify(d.hours) : null,
      JSON.stringify(d.strengths), JSON.stringify(d.tags), d.bookable === null ? null : d.bookable ? 1 : 0, now,
      // R12: 목록 원소 조각을 같은 행에 같이 쓴다 (쓰기 행 수는 그대로)
      listItemJson(detailRow(id, s, d, now)),
    )
    .run();
}

/** saveDetail이 저장했다가 다시 읽은 것과 같은 행 (저장하지 않고 보여줄 때) */
export function detailRow(id: string, s: PlaceSummary, d: PlaceDetail, now: number): PlaceRow {
  return {
    place: {
      id, name: s.name, categoryName: s.categoryName, group: categoryGroup(s.categoryName), lat: s.lat, lng: s.lng,
      address: s.address, phone: s.phone, photoUrl: s.photoUrl ?? null, url: placeUrl(id),
    },
    detail: { ...d, fetchedAt: now },
    meta: { status: "ok", fetchedAt: now, reason: null },
  };
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

async function metaNumber(db: D1Database, key: string): Promise<number> {
  const r = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  const v = Number(r?.value ?? 0);
  return Number.isFinite(v) ? v : 0;
}
const setMetaNumber = (db: D1Database, key: string, v: number) =>
  db.prepare(META_UPSERT).bind(key, String(v)).run();

/** 마지막으로 격자 ID가 바뀐 시각. Cron은 이 값이 마지막 미수집 확인 뒤일 때만 미수집 ID를 훑는다 */
export const tilesChangedAt = (db: D1Database) => metaNumber(db, TILES_CHANGED_KEY);
/** Cron이 모든 거점의 미수집 ID를 다 채웠다고 확인한 시각 */
export const unfetchedClearedAt = (db: D1Database) => metaNumber(db, UNFETCHED_CLEARED_KEY);
export const markUnfetchedCleared = async (db: D1Database, at: number) => {
  await setMetaNumber(db, UNFETCHED_CLEARED_KEY, at);
};

/** R44 강등 모드. frozen이면 until 전까지 상세 후보를 읽지도 부르지도 않는다 */
export type DetailGate = { blockedUntil: number; frozen: { since: number; until: number } | null };

function parseFrozen(raw: string | undefined): DetailGate["frozen"] {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { mode?: unknown; since?: unknown; until?: unknown };
    if (o.mode !== "frozen" || typeof o.since !== "number" || typeof o.until !== "number") return null;
    return { since: o.since, until: o.until };
  } catch {
    return null;
  }
}

/** R10 쿨다운과 R44 강등 모드를 한 번에 읽는다 (meta 2행) */
export async function detailGate(db: D1Database): Promise<DetailGate> {
  const r = await db
    .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
    .bind(BLOCKED_KEY, DETAIL_MODE_KEY)
    .all<{ key: string; value: string }>();
  const get = (k: string) => r.results.find((x) => x.key === k)?.value;
  const blocked = Number(get(BLOCKED_KEY) ?? 0);
  return { blockedUntil: Number.isFinite(blocked) ? blocked : 0, frozen: parseFrozen(get(DETAIL_MODE_KEY)) };
}

/** 지금 frozen이면 시작 시각, 아니면 null (24시간 뒤 자동 해제) */
export const frozenSince = (g: DetailGate, now: number): number | null =>
  g.frozen && now < g.frozen.until ? g.frozen.since : null;

/** 쿨다운도 frozen도 아니면 상세 API를 불러도 된다 */
export const detailsAllowed = (g: DetailGate, now: number): boolean => now >= g.blockedUntil && frozenSince(g, now) === null;

/**
 * R10/R44: 상세 API가 403/429를 줬을 때. 30분 쿨다운을 기록하고 오늘(KST) 차단 횟수를 1 올린다.
 * 같은 날 3번째부터는 24시간 frozen (이미 frozen이면 시작 시각은 두고 해제 시각만 늘린다).
 * 지난 날의 차단 횟수는 이때 함께 지운다 (차단이 있는 날만 한 행).
 * 쿨다운이 이미 걸려 있는 동안의 보고(요청 보충·Cron·R13이 겹친 같은 사고)는 쿨다운만 늘리고 횟수에는 넣지 않는다 —
 * 그래서 횟수 UPSERT가 쿨다운 기록보다 먼저, 이전 쿨다운이 끝났을 때만 돈다.
 */
export async function recordPlaceBlock(db: D1Database, now: number): Promise<void> {
  const key = `${BLOCK_COUNT_PREFIX}${kstDay(now)}`;
  const [counted] = await db.batch<{ value: string }>([
    db
      .prepare(
        `INSERT INTO meta (key, value) SELECT ?, '1'
         WHERE COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?), 0) <= ?
         ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1 RETURNING value`,
      )
      .bind(key, BLOCKED_KEY, now),
    db.prepare("DELETE FROM meta WHERE key LIKE ? AND key < ?").bind(`${BLOCK_COUNT_PREFIX}%`, key),
    db.prepare(META_UPSERT).bind(BLOCKED_KEY, String(now + PLACE_BLOCK_COOLDOWN_MS)),
  ]);
  const count = Number(counted.results[0]?.value ?? 0);
  if (count < DETAIL_FREEZE_AFTER_BLOCKS) return;
  const prev = frozenSince(await detailGate(db), now);
  const mode = { mode: "frozen", since: prev ?? now, until: now + DETAIL_FREEZE_MS };
  await db.prepare(META_UPSERT).bind(DETAIL_MODE_KEY, JSON.stringify(mode)).run();
}
