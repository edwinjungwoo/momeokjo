import { MAX_INTERVAL_WEEKS, WEEK_MS, detailFingerprint } from "../shared/adaptiveRefresh";
import { categoryGroup } from "../shared/category";
import {
  DETAIL_FAIL_TTL_MS, DETAIL_FREEZE_AFTER_BLOCKS, DETAIL_FREEZE_MS, DETAIL_JITTER_MS, DETAIL_OK_TTL_MS, LIST_JSON_VERSION,
  PLACE_BLOCK_COOLDOWN_MS,
} from "../shared/constants";
import { kstDay } from "../shared/kst";
import { haversine, tileRect, tilesCoveringCircle } from "../shared/geo";
import type { CategoryGroup, LatLng, Place, PlaceDetail, PlaceSummary, Rect, StoredDetail } from "../shared/types";
import { HUBS, type Hub } from "../shared/hubs";
import { hubsOfTile } from "./hubTiles";
import { listItemJson, storedListJson, usableListJson, usableListJsonSql } from "./present";
import { dueSinceOf, okDueBefore, refreshStartsIndex, tileFreshFrom, tileRefreshStart } from "./refreshSchedule";
import { deleteSnapshotsStmt, markHubsDirtyStmt, markPlaceHubsDirtyStmt, markPlacesHubsDirtyStmt } from "./snapshotDirty";

export type DetailMeta = { status: "ok" | "failed"; fetchedAt: number; reason: string | null } | null;
export type PlaceRow = { place: Place; detail: StoredDetail; meta: NonNullable<DetailMeta> };
export type TileState = { collectedAt: number; saturated: boolean };
export type TilePlaceState = { id: string; tileKey: string; meta: DetailMeta };

const CHUNK = 90;
const META_UPSERT = "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
const BLOCKED_KEY = "place_blocked_until";
export const TILES_CHANGED_KEY = "tiles_changed_at";
/** tiles_changed_at 올리기: MAX(이전 값 + 1, now) */
const TILES_CHANGED_BUMP = `INSERT INTO meta (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(meta.value AS INTEGER) + 1, CAST(excluded.value AS INTEGER))`;
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
  /** 0005: 목록 원소 조각 `v{LIST_JSON_VERSION}:{...}` (예전 행은 NULL이거나 예전 판) */
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
 * R56: ID가 바뀌면 이 격자를 덮는 거점의 스냅샷 표시를 올린다. 새 ID가 들어왔으면(상세가 없어 pending이 생긴다)
 * 그 거점 스냅샷을 지운다 — pending 0이라고 말하는 스냅샷이 남지 않게.
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
  if (stmts.length > 1) {
    // 언제나 커진다 (같은 now로 두 번, 더 이른 now가 늦게 와도) — 커서들이 "본 값과 같은지"로 격자 변화를 알아보므로 (Task 34)
    stmts.push(db.prepare(TILES_CHANGED_BUMP).bind(TILES_CHANGED_KEY, String(now)));
    const hubs = hubsOfTile(key);
    if (hubs.length > 0) {
      if (added.length > 0) stmts.push(deleteSnapshotsStmt(db, hubs));
      stmts.push(markHubsDirtyStmt(db, hubs, now));
    }
  }
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

/**
 * 수집할 격자인가: 없거나, tileFreshFrom 전에 수집했다 (R63 거점 격자는 그 거점들의 가장 늦은 갱신 시작, 밖은 7일 TTL — R3)
 */
export function isTileDue(key: string, state: TileState | undefined, now: number): boolean {
  return !state || state.collectedAt < tileFreshFrom(key, now);
}

/**
 * keys 중 수집할 격자(없음·만료 — isTileDue)만 keys 순서대로. getTiles + isTileDue와 같지만 격자 상태 행을 받아 오지 않는다
 * (Task 34: Cron은 모든 거점의 격자 수백 개를 실행마다 확인한다). 격자마다 기준 시각이 달라서 [key, freshFrom]을 넘긴다
 */
export async function dueTileKeys(db: D1Database, keys: string[], now: number): Promise<string[]> {
  if (keys.length === 0) return [];
  const r = await db
    .prepare(
      `SELECT json_extract(k.value, '$[0]') AS key FROM json_each(?) AS k
       WHERE NOT EXISTS (SELECT 1 FROM tiles t WHERE t.key = json_extract(k.value, '$[0]') AND t.collected_at >= json_extract(k.value, '$[1]'))
       ORDER BY k.key`,
    )
    .bind(JSON.stringify(keys.map((k) => [k, tileFreshFrom(k, now)])))
    .all<{ key: string }>();
  return r.results.map((x) => x.key);
}

/**
 * Task 40: 본 Cron 격자 확인 표시 — meta tiles_fresh = {fp, at}. at에 dueTileKeys로 확인했더니 수집할 격자가 하나도 없었고,
 * fp는 그때의 [격자, tileFreshFrom] 지문이다. 거점 격자의 기준(tileFreshFrom = 덮는 거점들의 가장 늦은 갱신 시작)은 다음 갱신
 * 요일까지 그대로고 수집 시각(collected_at)은 늘기만 하므로, 지문이 같으면 그사이 새로 수집할 격자가 생기지 않는다 —
 * 그래서 본 Cron은 지문이 같고 TILES_FRESH_RECHECK_MS 안이면 격자 수백 칸 확인(실행마다 ≈ 1천 행)을 건너뛴다.
 * 거점 밖 격자의 기준은 now를 따라 움직여서 지문이 실행마다 달라진다(언제나 확인). 손으로 tiles 행을 지우거나 되돌리는
 * 드문 일은 TILES_FRESH_RECHECK_MS 안에 다시 확인해 잡는다
 */
export const TILES_FRESH_KEY = "tiles_fresh";
export const TILES_FRESH_RECHECK_MS = 60 * 60_000;
type TilesFresh = { fp: string; at: number };

export const tilesFreshFingerprint = (keys: string[], now: number) =>
  tileSetFingerprint(keys.map((k) => `${k}@${tileFreshFrom(k, now)}`));

export function tilesKnownFresh(raw: string | undefined, fp: string, now: number): boolean {
  if (!raw) return false;
  try {
    const o = JSON.parse(raw) as Partial<TilesFresh>;
    return o.fp === fp && typeof o.at === "number" && o.at <= now && now - o.at < TILES_FRESH_RECHECK_MS;
  } catch {
    return false;
  }
}

export async function markTilesFresh(db: D1Database, fp: string, now: number): Promise<void> {
  const value: TilesFresh = { fp, at: now };
  await db.prepare(META_UPSERT).bind(TILES_FRESH_KEY, JSON.stringify(value)).run();
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

/** R9: 격자와 상관없는 만료 — ok 3일 + 지터, 실패 6시간 (거점 밖 격자, 단건 R13의 실패 재시도) */
export function isDetailDue(meta: DetailMeta, now: number, id: string): boolean {
  if (!meta) return true;
  const ttl = meta.status === "ok" ? DETAIL_OK_TTL_MS + detailJitterMs(id) : DETAIL_FAIL_TTL_MS;
  return now - meta.fetchedAt >= ttl;
}

/**
 * R63: tileKey 격자에 기록된 가게의 상세를 다시 가져올 때인가. 거점 격자의 ok는 그 격자의 갱신 기준 시각
 * (덮는 거점들의 가장 늦은 시작) 전에 가져왔을 때, 거점 밖 격자는 isDetailDue(3일 + 지터). 미수집은 언제나, 실패는 6시간
 */
export function isPlaceDue(meta: DetailMeta, tileKey: string, now: number, id: string): boolean {
  if (!meta || meta.status !== "ok") return isDetailDue(meta, now, id);
  const start = tileRefreshStart(tileKey, now);
  return start === null ? isDetailDue(meta, now, id) : meta.fetchedAt < start;
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

/**
 * 보충할 ID (격자 중심이 기준점에 가까운 순, 같으면 id순).
 * limit이 없으면(warm count=1) 격자-장소 상태를 다 읽어 고른다. limit이 있으면 nearestDetailIds (쪽 상한에서 멈추면 그때까지 고른 것).
 */
export async function idsNeedingDetail(
  db: D1Database, center: LatLng, radiusM: number, now: number, limit?: number, scope: DetailScope = "due",
): Promise<string[]> {
  if (limit === undefined) return pickDetailIds(await tilePlaceStates(db, tilesCoveringCircle(center, radiusM)), center, now, limit, scope);
  return (await nearestDetailIds(db, center, radiusM, now, limit, scope)).ids;
}

/** 기준점(여럿이면 가장 가까운 곳)에서 격자 중심까지 거리 — pickDetailIds와 SQL 순위(rankGroups)가 같은 값을 쓴다 */
function tileDistance(key: string, centers: readonly LatLng[]): number {
  const r = tileRect(key);
  const mid = { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 };
  return Math.min(...centers.map((c) => haversine(c, mid)));
}

/** 거리 순위가 같은 격자들 (rank 0부터 빈틈없이, 오름차순) */
type RankGroup = { rank: number; keys: string[] };

/**
 * 격자마다 거리 순위를 매겨(거리가 같으면 같은 순위) 순위별로 묶는다.
 * SQL은 (칸 순위, id)로 줄 세우고 Worker가 id마다 처음 나온 행만 쓴다 — 처음 나온 행이 가장 가까운 칸이라
 * pickDetailIds의 (가장 가까운 칸 거리, id) 순서와 같다.
 */
function rankGroups(keys: string[], centers: LatLng[]): RankGroup[] {
  const dist = new Map<string, number>();
  for (const k of keys) if (!dist.has(k)) dist.set(k, tileDistance(k, centers));
  const ds = [...new Set(dist.values())].sort((a, b) => a - b);
  const groups: RankGroup[] = ds.map((_, rank) => ({ rank, keys: [] }));
  const rankOf = new Map(ds.map((d, i) => [d, i] as const));
  for (const [k, d] of dist) groups[rankOf.get(d) as number].keys.push(k);
  return groups;
}
/** SQL ?1: [key, rank] JSON. now를 주면 [key, rank, okDueBefore] — 칸마다 ok 상세의 갱신 기준이 다르다 (R63) */
const rankedJson = (groups: RankGroup[], now?: number) =>
  JSON.stringify(groups.flatMap((g) => g.keys.map((k) => (now === undefined ? [k, g.rank] : [k, g.rank, okDueBefore(k, now)]))));

/**
 * 후보를 SQL에서 줄 세워 쪽씩 읽는다: 첫 쪽 max(limit, DETAIL_PICK_FIRST_PAGE)행, 다음 쪽은 DETAIL_PICK_GROWTH배씩,
 * 많아야 DETAIL_PICK_MAX_PAGES쪽 (쪽마다 D1이 후보를 다시 훑으므로 상한을 둔다 — R38). 보통은 첫 쪽에서 끝난다
 */
export const DETAIL_PICK_FIRST_PAGE = 100;
export const DETAIL_PICK_GROWTH = 4;
export const DETAIL_PICK_MAX_PAGES = 3;

/**
 * ?1 [key, rank] JSON, ?2 쪽 크기, ?3 offset (+ 조건의 바인드). (가게, 칸)마다 한 행 — GROUP BY보다 D1 읽기 행이 적다.
 * 정렬 키에 tile_key까지 넣어 쪽 경계가 실행마다 같다
 */
const nearestSql = (where: string) => `SELECT tp.place_id AS id, tp.tile_key AS tile_key, json_extract(k.value, '$[1]') AS r,
    p.status AS status, p.fetched_at AS fetched_at, p.fail_reason AS fail_reason
  FROM json_each(?1) AS k
  JOIN tile_places tp ON tp.tile_key = json_extract(k.value, '$[0]')
  LEFT JOIN places p ON p.id = tp.place_id
  WHERE ${where}
  ORDER BY json_extract(k.value, '$[1]'), tp.place_id, tp.tile_key
  LIMIT ?2 OFFSET ?3`;
export const NEAREST_UNFETCHED_SQL = nearestSql("p.id IS NULL");
/**
 * due일 수 있는 행: 상세 없음, ok는 칸의 기준(?1의 세 번째 값 okDueBefore — R63 거점 격자는 갱신 시작, 밖은 지터 전 3일) 전에
 * 가져옴(밖의 지터는 isPlaceDue로 다시 본다), 실패는 TTL이 지남. ?4 실패 기준(now − DETAIL_FAIL_TTL_MS)
 */
export const NEAREST_DUE_SQL = nearestSql(
  "(p.id IS NULL OR (p.status = 'ok' AND p.fetched_at < json_extract(k.value, '$[2]')) OR (p.status <> 'ok' AND p.fetched_at <= ?4))",
);
type NearestRow = {
  id: string; tile_key: string; r: number; status: string | null; fetched_at: number | null; fail_reason: string | null;
};

/**
 * ranked 격자의 후보를 (순위, id) 순서로 읽어 out을 want곳까지 채운다 (seen: 이미 본 id — 여러 칸에 기록된 가게는 처음 칸만).
 * 거점 밖 ok 행의 지터는 SQL에서 볼 수 없어서 Worker가 isPlaceDue로 거른다. firstRank: 처음 나온 행의 순위(없으면 null).
 * truncated: 쪽 상한까지 읽었는데 want곳을 못 채웠고 행이 더 있다.
 */
async function readNearest(
  db: D1Database, ranked: string, now: number, want: number, scope: DetailScope, seen: Set<string>, out: TilePlaceState[],
  maxPages = DETAIL_PICK_MAX_PAGES,
): Promise<{ firstRank: number | null; truncated: boolean; pages: number }> {
  let firstRank: number | null = null;
  let offset = 0;
  let page = Math.max(want, DETAIL_PICK_FIRST_PAGE);
  const pages = Math.min(maxPages, DETAIL_PICK_MAX_PAGES);
  for (let i = 0; i < pages; i++) {
    const stmt = scope === "unfetched"
      ? db.prepare(NEAREST_UNFETCHED_SQL).bind(ranked, page, offset)
      : db.prepare(NEAREST_DUE_SQL).bind(ranked, page, offset, now - DETAIL_FAIL_TTL_MS);
    const r = await stmt.all<NearestRow>();
    for (const x of r.results) {
      firstRank ??= x.r;
      if (out.length >= want) break;
      // 한 가게가 여러 칸에 기록됐으면 처음(가장 가까운 칸) 것만 — 상태는 칸과 상관없이 같다
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      const meta = metaOf(x.status, x.fetched_at, x.fail_reason);
      if (scope === "unfetched" || isPlaceDue(meta, x.tile_key, now, x.id)) out.push({ id: x.id, tileKey: x.tile_key, meta });
    }
    if (out.length >= want || r.results.length < page) return { firstRank, truncated: false, pages: i + 1 };
    offset += page;
    page *= DETAIL_PICK_GROWTH;
  }
  return { firstRank, truncated: true, pages };
}

/**
 * pickDetailIds(tilePlaceStates(덮는 격자), center, now, limit, scope)와 같은 ID를 같은 순서로 고른다 (Task 34 —
 * 덮는 격자의 상태 수천 행을 Worker로 받아 오지 않는다). truncated면 쪽 상한에서 멈춰 그때까지 고른 것이다(앞부분은 같다).
 */
export async function nearestDetailIds(
  db: D1Database, center: LatLng, radiusM: number, now: number, limit: number, scope: DetailScope = "due",
): Promise<{ ids: string[]; truncated: boolean }> {
  const want = Math.max(0, Math.floor(limit));
  const keys = tilesCoveringCircle(center, radiusM);
  if (want === 0 || keys.length === 0) return { ids: [], truncated: false };
  const out: TilePlaceState[] = [];
  const groups = rankGroups(keys, [center]);
  const ranked = scope === "unfetched" ? rankedJson(groups) : rankedJson(groups, now);
  const { truncated } = await readNearest(db, ranked, now, want, scope, new Set(), out);
  return { ids: out.map((t) => t.id), truncated };
}

/** Cron 미수집 앞선(frontier) 커서 — meta unfetched_from */
export const UNFETCHED_FROM_KEY = "unfetched_from";
/** 미수집을 찾을 때 한 질의가 읽는 칸 수 (순위 묶음은 쪼개지 않는다) */
export const UNFETCHED_CHUNK_TILES = 30;
/** 한 실행이 미수집을 찾으며 읽는 묶음 수 상한 (D1 질의 수·읽기 — 다음 실행이 이어 읽는다) */
export const UNFETCHED_MAX_CHUNKS = 6;
/**
 * Task 40: 지난 실행이 커서 순위에서 미수집을 찾았으면(hit) 먼저 작은 묶음들(이 칸 수씩 — 순위 묶음은 쪼개지 않는다)을 읽고,
 * 그래도 못 채우면 예전처럼 UNFETCHED_CHUNK_TILES칸 묶음 UNFETCHED_MAX_CHUNKS개까지 읽는다 (작은 묶음은 그 수에 넣지 않는다 —
 * 한 실행이 읽을 수 있는 칸은 예전보다 줄지 않는다). 미수집이 몰린 앞선 자리(새 거점)에서 실행마다 30칸(≈2천 행)을 다시 읽지 않게.
 * hit가 아니면(재설정·드문 미수집을 찾아 걷는 중) 예전처럼 처음부터 UNFETCHED_CHUNK_TILES칸씩
 */
export const UNFETCHED_PROBE_TILES: readonly number[] = [2, 4, 8, 16];
/** 미수집 찾기 한 번의 최대 D1 호출: 커서 읽기 1 + 작은 묶음 + 묶음 UNFETCHED_MAX_CHUNKS + 커서 쓰기 1 */
export const UNFETCHED_MAX_QUERIES = 2 + UNFETCHED_PROBE_TILES.length + UNFETCHED_MAX_CHUNKS;
/**
 * rank: 이 순위 앞 묶음에는 미수집이 없다. changedAt·keys: 그때의 tiles_changed_at과 격자·기준점 지문.
 * hit: rank 묶음에서 미수집을 찾았다 (없으면 읽다 멈춘 자리 — 예전 커서도 hit 없음)
 */
type FrontierCursor = { rank: number; changedAt: number; keys: string; hit?: true };

function parseFrontier(raw: string | undefined): FrontierCursor | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof FrontierCursor, unknown>>;
    return typeof o.rank === "number" && typeof o.changedAt === "number" && typeof o.keys === "string"
      ? { rank: o.rank, changedAt: o.changedAt, keys: o.keys, ...(o.hit === true ? { hit: true as const } : {}) }
      : null;
  } catch {
    return null;
  }
}

/** 순위가 격자 집합과 기준점에 달려 있어서 둘 다 지문에 넣는다 (순서 무관) */
const frontierFingerprint = (keys: string[], centers: LatLng[]) =>
  `${tileSetFingerprint(keys)}|${tileSetFingerprint(centers.map((c) => `${c.lat},${c.lng}`))}`;

export type UnfetchedPick = { states: TilePlaceState[]; cleared: boolean };

/**
 * R11 Cron: 주어진 격자에 기록됐지만 상세가 없는 장소 중 기준점에 가까운 순 limit곳.
 * Cron은 만료 후보와 이것을 합쳐 pickDetailIds로 limit곳을 고른다 — 미수집 전부를 합친 것과 같은 ID다(테스트).
 *
 * R38 읽기: 미수집은 가까운 칸부터 채워지므로 커서(meta unfetched_from = {rank, changedAt, keys})로 "이 순위 앞에는 미수집이
 * 없다"를 기억하고 다음 실행은 거기서부터 읽는다. 순위 묶음을 UNFETCHED_CHUNK_TILES칸쯤씩(묶음은 쪼개지 않는다) 읽다가
 * limit곳을 채우면 멈춘다. 새 커서 = 미수집이 처음 나온 순위 묶음(없으면 읽은 데까지).
 * 처음부터 다시 읽는 때: 커서가 없거나, tiles_changed_at이 커서의 값과 다르거나(격자에 ID가 들어왔을 수 있다 — R4),
 * 격자·기준점 지문이 다르다(거점 추가·변경). 미수집은 그 밖에는 생기지 않는다 — places 행을 손으로 지우면 unfetched_from도
 * 지운다(docs/deploy.md).
 * 실행마다 많아야 UNFETCHED_MAX_CHUNKS묶음 — 다 못 읽으면 다음 실행이 이어 읽는다. Task 40: 지난번에 커서 자리에서 미수집을 찾았으면(hit)
 * 그 앞에 작은 묶음(UNFETCHED_PROBE_TILES)부터 읽는다 — 새 거점처럼 미수집이 몰린 자리를 실행마다 30칸씩 다시 읽지 않게.
 * cleared: 끝까지 읽었고 미수집이 없다. limit이 0이면 읽지 않고 cleared도 아니다. 커서가 끝(마지막 순위 + 1)이고 tiles_changed_at·지문이
 * 같으면 묶음 질의 없이 cleared다 — 그래서 Cron은 따로 "미수집 확인 끝" 표시를 두지 않는다 (tiles_changed_at은 바뀔 때마다 커진다).
 * opts.changedAt: 호출하는 쪽이 한 번 읽은 tiles_changed_at (다시 읽지 않는다). opts.maxQueries: 이번에 쓸 D1 호출 수 상한
 * (커서 읽기·쓰기 포함 — 3보다 적으면 읽지 않는다. 묶음·쪽을 다 못 읽으면 다음 실행이 커서부터 이어 읽는다).
 */
export async function nearestUnfetchedStates(
  db: D1Database, keys: string[], centers: LatLng[], limit: number, opts: { changedAt?: number; maxQueries?: number } = {},
): Promise<UnfetchedPick> {
  const want = Math.max(0, Math.floor(limit));
  if (want === 0) return { states: [], cleared: false };
  if (keys.length === 0) return { states: [], cleared: true };
  // D1 호출: 커서 읽기 1 + 묶음 질의 1 이상 + 커서 쓰기 1 — 그만큼 없으면 이번에는 읽지 않는다
  const maxQueries = opts.maxQueries ?? Number.POSITIVE_INFINITY;
  if (maxQueries < 3) return { states: [], cleared: false };
  const walkQueries = maxQueries - 2;
  const groups = rankGroups(keys, centers);
  const fingerprint = frontierFingerprint(keys, centers);
  const m = await db
    .prepare("SELECT key, value FROM meta WHERE key IN (?, ?)")
    .bind(UNFETCHED_FROM_KEY, opts.changedAt === undefined ? TILES_CHANGED_KEY : UNFETCHED_FROM_KEY)
    .all<{ key: string; value: string }>();
  const get = (k: string) => m.results.find((x) => x.key === k)?.value;
  const changedNum = opts.changedAt ?? Number(get(TILES_CHANGED_KEY) ?? 0);
  const changedAt = Number.isFinite(changedNum) ? changedNum : 0;
  const cursor = parseFrontier(get(UNFETCHED_FROM_KEY));
  const resume = cursor !== null && cursor.changedAt === changedAt && cursor.keys === fingerprint;
  const startRank = resume ? cursor.rank : 0;

  let gi = groups.findIndex((g) => g.rank >= startRank);
  if (gi < 0) gi = groups.length;
  const seen = new Set<string>();
  const out: TilePlaceState[] = [];
  let frontier: number | null = null;
  let used = 0;
  // Task 40: 앞선 자리에 미수집이 있었으면 작은 묶음부터 (고르는 결과는 같다 — 순위 묶음 순서대로 읽고 want에서 멈춘다)
  const sizes = [...(resume && cursor.hit ? UNFETCHED_PROBE_TILES : []), ...Array<number>(UNFETCHED_MAX_CHUNKS).fill(UNFETCHED_CHUNK_TILES)];
  for (let chunks = 0; gi < groups.length && out.length < want && chunks < sizes.length && used < walkQueries; chunks++) {
    const chunk: RankGroup[] = [];
    const size = sizes[chunks];
    for (let tiles = 0; gi < groups.length && (chunk.length === 0 || tiles < size); gi++) {
      chunk.push(groups[gi]);
      tiles += groups[gi].keys.length;
    }
    const r = await readNearest(db, rankedJson(chunk), 0, want, "unfetched", seen, out, walkQueries - used);
    used += r.pages;
    frontier ??= r.firstRank;
    if (r.truncated) break;
  }
  const end = groups.length; // 마지막 순위 + 1
  const nextRank = frontier ?? (gi < groups.length ? groups[gi].rank : end);
  const cleared = frontier === null && gi >= groups.length;
  const hit = frontier !== null;
  if (
    cursor === null || cursor.rank !== nextRank || cursor.changedAt !== changedAt || cursor.keys !== fingerprint ||
    (cursor.hit === true) !== hit
  ) {
    const value: FrontierCursor = { rank: nextRank, changedAt, keys: fingerprint, ...(hit ? { hit: true as const } : {}) };
    await db.prepare(META_UPSERT).bind(UNFETCHED_FROM_KEY, JSON.stringify(value)).run();
  }
  return { states: out, cleared };
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
  const distOf = new Map<string, number>();
  for (const t of states) {
    if (scope === "unfetched" ? t.meta !== null : !isPlaceDue(t.meta, t.tileKey, now, t.id)) continue;
    let d = distOf.get(t.tileKey);
    if (d === undefined) distOf.set(t.tileKey, (d = tileDistance(t.tileKey, centers)));
    const prev = nearest.get(t.id);
    if (prev === undefined || d < prev) nearest.set(t.id, d);
  }
  const ids = [...nearest.entries()]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
  return limit === undefined ? ids : ids.slice(0, limit);
}

/**
 * R63 Cron 순서: 미수집(새 가게)을 먼저 가까운 순으로, 그다음 갱신 대상이 된 시각(dueSinceOf — 거점 격자는 갱신 시작)이
 * 오래된 것부터, 같으면 가장 가까운 거점까지 칸 거리 순, 같으면 id순. 한 가게가 여러 칸에 있으면 대상인 칸 중 (시각, 거리)가 가장 앞선 것.
 * 그래서 시작이 오래된 거점의 갱신이 먼저 끝나고, 한 거점 안에서는 예전처럼 가까운 순이다.
 * 갱신 대상 판단·시작·거리는 넘겨받은 거점(hubs)으로만 본다 (거점 밖 칸은 3일 + 지터 — isDetailDue).
 * R9: 배치가 2곳 이상이고 대상인 실패 행이 있는데 자리 안에 없으면, 마지막 후보를 빼고 가장 오래 기다린 실패 행을 맨 앞에 둔다 —
 * 밀린 갱신 뒤로 6시간 재시도가 끝없이 밀리지 않게 (실패는 dueSince가 늦어서 그대로면 맨 뒤다). 맨 앞인 까닭: enrichDetails는
 * 글자 예산(DETAIL_CHAR_BUDGET)·D1 호출이 모자라면 배치 뒤쪽을 남기므로(deferred), 마지막 자리면 배치 6 + 글자 200,000자에서 늘 남겨진다.
 */
export function pickCronIds(states: TilePlaceState[], hubs: readonly Hub[], now: number, limit: number): string[] {
  const startsOf = refreshStartsIndex(hubs, now);
  const best = new Map<string, { since: number; d: number; failed: boolean }>();
  const distOf = new Map<string, number>();
  for (const t of states) {
    const starts = startsOf.get(t.tileKey) ?? [];
    const due = !t.meta
      ? true
      : t.meta.status !== "ok" || starts.length === 0
        ? isDetailDue(t.meta, now, t.id)
        : t.meta.fetchedAt < starts[starts.length - 1];
    if (!due) continue;
    const since = t.meta === null ? Number.NEGATIVE_INFINITY : dueSinceOf(t.meta, starts, detailJitterMs(t.id));
    let d = distOf.get(t.tileKey);
    if (d === undefined) distOf.set(t.tileKey, (d = tileDistance(t.tileKey, hubs)));
    const prev = best.get(t.id);
    if (!prev || since < prev.since || (since === prev.since && d < prev.d)) {
      best.set(t.id, { since, d, failed: t.meta !== null && t.meta.status !== "ok" });
    }
  }
  const sorted = [...best.entries()].sort(
    ([a, x], [b, y]) => x.since - y.since || x.d - y.d || (a < b ? -1 : a > b ? 1 : 0),
  );
  const n = Math.max(0, Math.floor(limit));
  const picked = sorted.slice(0, n);
  if (n >= 2 && sorted.length > n && !picked.some(([, x]) => x.failed)) {
    const fail = sorted.slice(n).find(([, x]) => x.failed);
    if (fail) {
      picked.pop();
      picked.unshift(fail);
    }
  }
  return picked.map(([id]) => id);
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
/** 한 실행이 대상 행이 나올 때까지 읽는 쪽 수 (재설정 포함) — 상태마다 최대 3 × 300행 */
export const EXPIRED_RESET_PAGES = 3;
const EXPIRED_COLS = `SELECT p.rowid AS rid, p.id AS id, p.status AS status, p.fetched_at AS fetched_at,
    p.fail_reason AS fail_reason, tp.tile_key AS tile_key
  FROM places p INDEXED BY idx_places_status_fetched_at LEFT JOIN tile_places tp ON tp.place_id = p.id`;
/**
 * (status, fetched_at) 인덱스를 오래된 순으로 범위만 읽는다. 격자는 행마다 place_id 인덱스로 붙인다.
 * 위치는 (fetched_at, rowid)로 정해서 같은 fetched_at이 한 쪽보다 많아도 넘어간다. 인덱스 키가 (status, fetched_at, rowid)라
 * "같은 fetched_at의 rowid 이후" + "더 늦은 fetched_at" 두 범위를 인덱스 순서대로 합친다(MERGE, 정렬용 임시 B-트리 없음).
 * (행 값 비교 (fetched_at, rowid) >= (?, ?)는 SQLite가 fetched_at까지만 탐색에 써서 같은 시각 행을 처음부터 다시 읽는다)
 * 바인드: ?1 status, ?2 from(포함), ?3 fromRowid(포함), ?4 before(포함), ?5 limit
 */
export const EXPIRED_SCAN_SQL = `${EXPIRED_COLS}
  WHERE p.status = ?1 AND p.fetched_at = ?2 AND p.rowid >= ?3 AND p.fetched_at <= ?4
UNION ALL
${EXPIRED_COLS}
  WHERE p.status = ?1 AND p.fetched_at > ?2 AND p.fetched_at <= ?4
ORDER BY fetched_at, rid LIMIT ?5`;
const EXPIRED_FROM_PREFIX = "expired_from:";
/**
 * from·rid: 다음 실행이 읽기 시작할 위치. changedAt·keys: 커서를 쓸 때 본 tiles_changed_at과 거점 격자 집합 지문
 * (ok 커서의 지문에는 R63 칸마다의 갱신 시작도 들어간다 — 시작이 바뀌면 처음부터 다시 읽는다)
 */
type ScanCursor = { from: number; rid: number; changedAt: number; keys: string };

function parseCursor(raw: string | undefined): ScanCursor | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<Record<keyof ScanCursor, unknown>>;
    const { from, rid, changedAt, keys } = o;
    return typeof from === "number" && typeof rid === "number" && typeof changedAt === "number" && typeof keys === "string"
      ? { from, rid, changedAt, keys }
      : null;
  } catch {
    return null;
  }
}

/** 격자 집합의 지문 (순서·중복 무관): 개수 + FNV-1a 32비트 */
export function tileSetFingerprint(keys: Iterable<string>): string {
  const sorted = [...new Set(keys)].sort();
  let h = 0x811c9dc5;
  for (const k of sorted) {
    for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193);
    h = Math.imul(h ^ 0x2c, 0x01000193); // 구분자
  }
  return `${sorted.length}:${(h >>> 0).toString(16)}`;
}

type ExpiredRow = { rid: number; id: string; status: string; fetched_at: number; fail_reason: string | null; tile_key: string | null };

/**
 * Cron용(R11): 주어진 격자(= 모든 거점의 PREWARM_RADIUS 격자)의 장소 중 갱신 대상일 수 있는 것.
 * R63: ok는 칸마다 기준(okDueBefore)이 다르다 — 거점 격자는 그 칸 거점들의 가장 늦은 갱신 시작 전에 가져온 것(정확),
 * 거점 밖 칸은 지터 전 3일(실제 만료는 isPlaceDue로 다시 확인). 실패는 6시간.
 *
 * R38 읽기 예산: 상태마다 (status, fetched_at) 인덱스를 오래된 순으로 EXPIRED_SCAN_LIMIT행까지만 읽는다.
 * ok의 범위 상한은 주어진 칸 기준 중 가장 늦은 것(가장 최근에 시작한 거점의 시작)이고, 행마다 붙인 칸의 기준으로 거른다.
 * 대상이 아닌 행(거점 밖 행 — 예전 warm의 ASEM 1500m 고리, 격자에 없는 단건 조회 — 와 자기 거점 시작 뒤에 가져온 행)은
 * 늘 인덱스 앞쪽에 남으므로, 상태마다 "여기부터 읽는다" 커서(meta expired_from:{status} = (fetched_at, rowid))를 둔다 —
 * 첫 대상 행의 위치, 없었으면 지나간 마지막 행(다 읽었으면 상한). 그 앞에는 대상 행이 없으니 다음 실행은 건너뛴다.
 * 대상 행은 갱신되면 fetched_at이 앞으로 가므로 커서 앞에 새로 생기지 않고, 대상이 아닌 행은 기준이 바뀌기 전에는 대상이
 * 되지 않는다(거점 격자의 기준은 다음 갱신 요일까지 그대로다). 처음부터 다시 읽는(재설정) 때:
 * - 커서를 쓸 때 본 tiles_changed_at과 지금 값이 다르다 (오래된 행이 거점 격자에 새로 들어왔을 수 있다).
 *   크기가 아니라 같은지로 본다 — 요청이 Cron보다 이른 시각으로 늦게 기록해도 놓치지 않는다.
 * - 거점 격자 집합(keys)의 지문이 다르다 (거점 추가·변경). ok는 칸마다의 갱신 시작도 지문에 넣는다 — 어느 거점이든 새 갱신
 *   요일이 되면(하루 한 번쯤) 커서 앞의 그 거점 행이 대상이 되므로 처음부터 다시 읽는다.
 * 실행마다 대상 행이 나올 때까지 EXPIRED_RESET_PAGES쪽까지 이어 읽는다 (R63 — 예전에는 재설정 때만, 다음 실행은 한 쪽씩이었다.
 * 거점마다 갱신 창이 겹치면 대상 행 사이에 대상 아닌 행이 끼어 있어서 실행마다 한 쪽만 나아가면 보충이 멈춘다).
 */
export async function expiredDetailStates(
  db: D1Database, keys: string[], now: number, observedChangedAt?: number,
  /** Task 40: "failed"면 실패 행만 읽는다 (ok 커서는 읽지도 쓰지도 않는다 — 미수집이 배치를 다 채운 실행) */
  only?: "failed",
): Promise<TilePlaceState[]> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return [];
  // 칸 → ok 기준(이 시각 전에 가져온 것만 대상)
  const okBefore = new Map(unique.map((k) => [k, okDueBefore(k, now)] as const));
  const keysFingerprint = tileSetFingerprint(unique);
  // 거점 격자의 기준(갱신 시작)은 다음 갱신 요일까지 그대로라 지문에 넣는다. 거점 밖 칸의 기준은 now를 따라 움직여서 넣지 않는다
  const okFingerprint = tileSetFingerprint(unique.map((k) => (tileRefreshStart(k, now) === null ? k : `${k}@${okBefore.get(k)}`)));
  // Cron은 한 번 읽은 tiles_changed_at을 넘겨서 다시 읽지 않는다 (Task 34 D1 호출 예산)
  const changedAt = observedChangedAt ?? (await tilesChangedAt(db));
  const failBefore = now - DETAIL_FAIL_TTL_MS;
  const statuses = [
    { status: "ok", before: Math.max(...okBefore.values()) - 1, fingerprint: okFingerprint, due: (x: ExpiredRow, k: string) => x.fetched_at < (okBefore.get(k) as number) },
    { status: "failed", before: failBefore, fingerprint: keysFingerprint, due: () => true },
  ].filter((x) => only === undefined || x.status === only);
  const saved = await db
    .prepare(`SELECT key, value FROM meta WHERE key IN (${marks(statuses.length)})`)
    .bind(...statuses.map((x) => EXPIRED_FROM_PREFIX + x.status))
    .all<{ key: string; value: string }>();
  const out: TilePlaceState[] = [];
  const writes: D1PreparedStatement[] = [];
  for (const { status, before, fingerprint, due } of statuses) {
    const key = EXPIRED_FROM_PREFIX + status;
    const cursor = parseCursor(saved.results.find((x) => x.key === key)?.value);
    const reset = cursor === null || cursor.changedAt !== changedAt || cursor.keys !== fingerprint;
    let pos = reset ? { from: 0, rid: 0 } : { from: cursor.from, rid: cursor.rid };
    let next: { from: number; rid: number } | null = null;
    // R63: 재설정이 아니어도 대상 행이 나올 때까지 EXPIRED_RESET_PAGES쪽까지 (갱신 창이 겹치면 대상 아닌 행이 끼어 있다 — 최악 호출 수는 그대로)
    for (let page = 0; page < EXPIRED_RESET_PAGES && next === null; page++) {
      const r = await db
        .prepare(EXPIRED_SCAN_SQL)
        .bind(status, pos.from, pos.rid, before, EXPIRED_SCAN_LIMIT)
        .all<ExpiredRow>();
      for (const x of r.results) {
        if (x.tile_key === null || !okBefore.has(x.tile_key) || !due(x, x.tile_key)) continue;
        next ??= { from: x.fetched_at, rid: x.rid };
        out.push({ id: x.id, tileKey: x.tile_key, meta: metaOf(x.status, x.fetched_at, x.fail_reason) });
      }
      if (next !== null) break;
      if (r.results.length < EXPIRED_SCAN_LIMIT) {
        // before까지 다 읽었다 — 다음 실행은 before부터
        pos = { from: Math.max(pos.from, before), rid: 0 };
        break;
      }
      // 한 쪽을 다 읽었는데 대상 행이 없다 — 마지막 행부터 잇는다 (포함: 두 칸에 기록된 가게가 쪽 경계에서 잘려도 놓치지 않게)
      const last = r.results[r.results.length - 1];
      pos = { from: last.fetched_at, rid: last.rid };
    }
    next ??= pos;
    if (reset || next.from !== cursor.from || next.rid !== cursor.rid) {
      const value: ScanCursor = { from: next.from, rid: next.rid, changedAt, keys: fingerprint };
      writes.push(db.prepare(META_UPSERT).bind(key, JSON.stringify(value)));
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

/**
 * 지금 판 조각(list_json)이 있으면 무거운 열(메뉴·영업시간·강점·태그 JSON 등)은 받지 않는다 — D1 결과 크기와 Worker CPU를 아낀다.
 * 조각이 없거나 예전 판·깨진 값이면 조각 대신 열을 받는다 (판단은 usableListJson과 같은 접두어 비교)
 */
const USABLE = usableListJsonSql("list_json");
const heavy = (col: string) => `CASE WHEN ${USABLE} THEN NULL ELSE ${col} END AS ${col}`;
const LIST_SELECT = `SELECT id, status, name, category_name, category_group, lat, lng, fetched_at,
  CASE WHEN ${USABLE} THEN list_json END AS list_json,
  ${["address", "phone", "photo_url", "rating", "review_count", "price", "menus_json", "hours_json", "strengths_json", "tags_json", "bookable", "fail_reason"].map(heavy).join(", ")}
  FROM places WHERE name IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL`;

/**
 * R12 목록: placesInBox와 같은 행을 고르되, 미리 만든 목록 원소 조각(list_json)을 그대로 쓴다.
 * 지금 판 조각이 없는 행(0005 전, 예전 LIST_JSON_VERSION, 깨진 값)만 열에서 만든다 (toRow → listItemJson, 결과는 같다).
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
      json: usableListJson(x.list_json) ?? listItemJson(toRow(x)),
    });
  }
  return out;
}

/** Cron이 한 번에 채우는 list_json 수 (쓰기 ≤ 200행/실행) */
export const LIST_BACKFILL_LIMIT = 200;
/** 판마다 커서가 따로다 — LIST_JSON_VERSION을 올리면 Cron이 places를 처음부터 다시 훑어 새 판으로 쓴다 */
const LIST_BACKFILL_KEY = `list_json_backfill:v${LIST_JSON_VERSION}`;
const LIST_BACKFILL_DONE = "done";

/**
 * 지금 판 조각이 없는 행(0005 전 NULL, 예전 LIST_JSON_VERSION, 깨진 값)의 list_json을 rowid 순으로
 * LIST_BACKFILL_LIMIT행씩 다시 쓴다. 쓴 수를 돌려준다.
 * 커서(meta list_json_backfill:v{판} = 마지막 rowid)로 이어 읽어서 실행마다 places를 처음부터 훑지 않고,
 * 끝까지 읽으면 "done"을 남겨 그 뒤로는 meta 1행만 읽는다 (새 행은 saveDetail이 처음부터 지금 판으로 쓴다).
 * 그 사이 상세가 다시 저장된 행은 건드리지 않는다 (fetched_at이 같고 아직 지금 판이 아닐 때만 쓴다).
 */
export async function backfillListJson(db: D1Database): Promise<number> {
  const cur = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(LIST_BACKFILL_KEY).first<{ value: string }>();
  if (cur?.value === LIST_BACKFILL_DONE) return 0;
  const after = Number(cur?.value ?? 0) || 0;
  const r = await db
    .prepare("SELECT rowid AS rid, * FROM places WHERE rowid > ? ORDER BY rowid LIMIT ?")
    .bind(after, LIST_BACKFILL_LIMIT)
    .all<DbRow & { rid: number }>();
  const fill = listJsonFill(r.results);
  const stmts = listJsonUpdates(db, fill);
  const last = r.results[r.results.length - 1]?.rid;
  const next = r.results.length < LIST_BACKFILL_LIMIT ? LIST_BACKFILL_DONE : String(last);
  stmts.push(db.prepare(META_UPSERT).bind(LIST_BACKFILL_KEY, next));
  await db.batch(stmts);
  return fill.length;
}

type ListJsonFill = readonly [id: string, fetchedAt: number, json: string];

/**
 * 표시 정보가 있고 지금 판 조각이 없는 행의 조각을 만든다 — Cron과 관리자 백필이 saveDetail과 같은 직렬화
 * (toRow → storedListJson)를 쓴다
 */
const listJsonFill = (rows: DbRow[]): ListJsonFill[] =>
  rows
    .filter((x) => usableListJson(x.list_json) === null && x.name !== null && x.lat !== null && x.lng !== null)
    .map((x) => [x.id, x.fetched_at, storedListJson(toRow(x))] as const);

/** 지금 판 조각이 없는 행 (NULL·예전 판·깨진 값) — col이 NULL이면 substr 비교도 NULL이라 따로 본다 */
const staleListJsonSql = (col: string) => `(${col} IS NULL OR NOT ${usableListJsonSql(col)})`;

/** 100행마다 UPDATE 한 문장. 그 사이 상세가 다시 저장된 행은 건드리지 않는다 (fetched_at이 같고 아직 지금 판이 아닐 때만) */
function listJsonUpdates(db: D1Database, fill: ListJsonFill[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < fill.length; i += 100) {
    stmts.push(
      db
        .prepare(
          `UPDATE places SET list_json = json_extract(u.value, '$[2]') FROM json_each(?) AS u
           WHERE places.id = json_extract(u.value, '$[0]') AND places.fetched_at = json_extract(u.value, '$[1]')
             AND ${staleListJsonSql("places.list_json")}`,
        )
        .bind(JSON.stringify(fill.slice(i, i + 100))),
    );
  }
  return stmts;
}

/**
 * 관리자 백필(POST /api/admin/backfill) 한 번에 채우는 행 수의 기본값·최댓값 (더 큰 limit은 최댓값으로 줄인다).
 * Workers CPU 10ms 안에 넉넉히 들게 정했다 — `node scripts/bench-places.mjs backfill`(Node 26, 이 Mac) 중앙값:
 * 300행 직렬화 1.37ms + D1 결과 해석 근사 0.41ms → ×3 ≈ 5.4ms (≤ 6ms). 400행은 ×3 ≈ 7.2ms, 1000행은 ≈ 18ms라 넘는다.
 */
export const ADMIN_BACKFILL_DEFAULT = 300;
export const ADMIN_BACKFILL_MAX = 300;

/** 관리자 백필 후보: 격자 기록에서 출발해 PK로 가게를 찾는다 (CROSS JOIN으로 순서를 고정 — places 상태 인덱스를 훑지 않게) */
export const ADMIN_BACKFILL_SQL = `SELECT p.* FROM tile_places tp CROSS JOIN places p ON p.id = tp.place_id
  WHERE tp.tile_key IN (SELECT value FROM json_each(?))
    AND ${staleListJsonSql("p.list_json")} AND p.name IS NOT NULL AND p.lat IS NOT NULL AND p.lng IS NOT NULL
  LIMIT ?`;

/**
 * 배포 직후 관리자 백필: 주어진 격자(거점)에 기록된 가게 중 지금 판 list_json이 없는(NULL·예전 판·깨진 값) 행을
 * limit개까지 채운다.
 * Cron 백필(backfillListJson)과 같은 직렬화·같은 UPDATE를 쓰고, 커서는 쓰지 않는다 (채운 행은 다음 조회에서 빠진다).
 * 격자 기록(tile_places)에서 출발해 그 거점 가게만 읽는다 (places 전체를 훑지 않는다 — ADMIN_BACKFILL_SQL).
 * 후보는 Cron 백필과 같다 — status와 상관없이 표시 정보(이름·좌표)가 있는 행 (failed여도 목록에는 보인다).
 * limit + 1행을 읽어서 남은 것이 있는지(more) 알려 준다. filled는 실제로 바뀐 행 수다.
 */
export async function backfillListJsonIn(
  db: D1Database, keys: string[], limit: number,
): Promise<{ filled: number; remaining: "more" | 0 }> {
  const r = await db.prepare(ADMIN_BACKFILL_SQL).bind(JSON.stringify(keys), limit + 1).all<DbRow>();
  // 한 가게가 두 칸에 기록됐으면 두 번 나온다 — 한 번만 채운다 (남은 것이 있는지는 읽은 행 수로 본다)
  const seen = new Set<string>();
  const rows = r.results.filter((x) => !seen.has(x.id) && seen.add(x.id)).slice(0, limit);
  const stmts = listJsonUpdates(db, listJsonFill(rows));
  const filled = stmts.length === 0 ? 0 : (await db.batch(stmts)).reduce((n, x) => n + (Number(x.meta?.changes) || 0), 0);
  return { filled, remaining: r.results.length > limit ? "more" : 0 };
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

/**
 * 상세 한 곳을 쓰는 문장 (saveDetail과 saveDetails가 같은 문장을 쓴다). 예전처럼 행을 통째로 바꿔 쓰고(INSERT OR REPLACE),
 * R66 주기는 바꾸기 전 행(PK로 한 행)의 지문·주기로 정한다: 지문이 같으면 MIN(4, 주기 × 2), 다르거나 이전 지문이 없거나(처음·마이그레이션
 * 전 행·실패만 있던 행) 행이 없으면 1. ?21(weekly)이면 지문과 상관없이 1 (R66 볼 때 신선하게 — 열어 본 가게).
 * due_after = fetched_at + (주기 − 1) × 7일. 바인드: ?1 id … ?18 now, ?19 list_json, ?20 fp, ?21 weekly(0/1)
 */
const DETAIL_SAVE_SQL = `INSERT OR REPLACE INTO places (id, status, name, category_name, category_group, lat, lng, address, phone, photo_url,
    rating, review_count, price, menus_json, hours_json, strengths_json, tags_json, bookable, fail_reason, fetched_at,
    list_json, fp, interval_weeks, due_after)
  SELECT ?1, 'ok', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, NULL, ?18,
    ?19, ?20, w.iv, ?18 + (w.iv - 1) * ${WEEK_MS}
  FROM (SELECT CASE WHEN ?21 THEN 1 ELSE COALESCE(
    (SELECT CASE WHEN o.fp = ?20 THEN MIN(${MAX_INTERVAL_WEEKS}, o.interval_weeks * 2) ELSE 1 END FROM places o WHERE o.id = ?1), 1)
    END AS iv) AS w`;

function detailInsertStmt(
  db: D1Database, id: string, s: PlaceSummary, d: PlaceDetail, now: number, opts: SaveOpts = {},
): D1PreparedStatement {
  return db
    .prepare(DETAIL_SAVE_SQL)
    .bind(
      id, s.name, s.categoryName, categoryGroup(s.categoryName), s.lat, s.lng, s.address, s.phone, s.photoUrl,
      d.rating, d.reviewCount, d.price, JSON.stringify(d.menus), d.hours ? JSON.stringify(d.hours) : null,
      JSON.stringify(d.strengths), JSON.stringify(d.tags), d.bookable === null ? null : d.bookable ? 1 : 0, now,
      // R12: 목록 원소 조각을 같은 행에 같이 쓴다 (쓰기 행 수는 그대로)
      storedListJson(detailRow(id, s, d, now)),
      opts.fp ?? detailFingerprint(s, d),
      opts.weekly ? 1 : 0,
    );
}

/** R66 저장 선택: fp는 이미 계산한 지문(없으면 여기서), weekly면 주기 1로 (열어 본 가게) */
export type SaveOpts = { fp?: string; weekly?: boolean };

/** 실패 한 곳을 쓰는 문장 (표시 정보는 그대로 두고 상태만 바꾼다 — saveDetailFailure와 saveDetails가 같은 문장을 쓴다) */
function detailFailureStmt(db: D1Database, id: string, reason: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO places (id, status, fail_reason, fetched_at) VALUES (?, 'failed', ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'failed', fail_reason = excluded.fail_reason, fetched_at = excluded.fetched_at`,
    )
    .bind(id, reason, now);
}

/** R56: 상세 저장·실패 기록은 같은 batch에서 그 가게가 보이는 거점의 스냅샷 표시를 올린다 (snapshotDirty.ts) */
export async function saveDetail(
  db: D1Database, id: string, s: PlaceSummary, d: PlaceDetail, now: number, opts: SaveOpts = {},
): Promise<void> {
  // 표시 문장을 먼저 둔다 — 옮기기 전 좌표(저장된 행)도 보게
  const mark = markPlaceHubsDirtyStmt(db, id, { lat: s.lat, lng: s.lng }, now);
  await db.batch([mark, detailInsertStmt(db, id, s, d, now, opts)]);
}

/** 한 번의 보충에서 저장할 것: 상세(summary·detail, R66 fp — 없으면 저장할 때 계산) 또는 실패 사유 */
export type DetailSave = { id: string; summary: PlaceSummary; detail: PlaceDetail; fp?: string } | { id: string; reason: string };

/**
 * Task 34: 한 번의 보충 결과를 D1 batch 하나로 쓴다 (한 곳씩 saveDetail·saveDetailFailure를 부른 것과 같은 행·같은 list_json).
 * 거점 표시는 맨 앞 한 문장으로 — 저장 전 좌표나 새 좌표가 1000m 상자 안인 거점을 거점마다 한 번 올린다
 * (한 곳씩이면 같은 거점을 곳마다 올린다. 표시는 "바뀌었다"만 뜻해서 오른 거점이 같으면 같다).
 * batch는 한 트랜잭션이라 스냅샷 Cron이 반쯤 저장된 상태를 보지 않는다. 같은 id가 두 번 오지 않는다(후보는 중복 없음).
 */
export async function saveDetails(db: D1Database, saves: DetailSave[], now: number): Promise<void> {
  if (saves.length === 0) return;
  const mark = markPlacesHubsDirtyStmt(
    db, saves.map((x) => ({ id: x.id, next: "summary" in x ? { lat: x.summary.lat, lng: x.summary.lng } : null })), now,
  );
  await db.batch([
    mark,
    ...saves.map((x) =>
      "summary" in x ? detailInsertStmt(db, x.id, x.summary, x.detail, now, { fp: x.fp }) : detailFailureStmt(db, x.id, x.reason, now)
    ),
  ]);
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
  await db.batch([
    detailFailureStmt(db, id, reason, now),
    // 표시 정보(좌표)가 남아 있는 행이면 그 거점 목록의 detailsNewestAt이 바뀔 수 있다 (좌표가 없으면 목록에 없다)
    markPlaceHubsDirtyStmt(db, id, null, now),
  ]);
}

async function metaNumber(db: D1Database, key: string): Promise<number> {
  const r = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  const v = Number(r?.value ?? 0);
  return Number.isFinite(v) ? v : 0;
}

/**
 * 격자 ID가 바뀔 때마다 커지는 값 (MAX(이전 + 1, now) — replaceTilePlaces). 만료·미수집 커서는 쓸 때 본 값과 같은지로
 * 격자 변화를 알아보고 다르면 처음부터 다시 읽는다
 */
export const tilesChangedAt = (db: D1Database) => metaNumber(db, TILES_CHANGED_KEY);

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
 * R56: 모든 거점 스냅샷을 지우고 표시를 올린다 (detailsPaused·detailsFrozenSince가 바뀐다).
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
    deleteSnapshotsStmt(db),
    markHubsDirtyStmt(db, HUBS.map((h) => h.id), now),
  ]);
  const count = Number(counted.results[0]?.value ?? 0);
  if (count < DETAIL_FREEZE_AFTER_BLOCKS) return;
  const prev = frozenSince(await detailGate(db), now);
  const mode = { mode: "frozen", since: prev ?? now, until: now + DETAIL_FREEZE_MS };
  await db.prepare(META_UPSERT).bind(DETAIL_MODE_KEY, JSON.stringify(mode)).run();
}
