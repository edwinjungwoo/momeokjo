import { MAX_RADIUS } from "../shared/constants";
import { tilesCoveringCircle } from "../shared/geo";
import { HUBS, type Hub } from "../shared/hubs";
import { readHubRefreshed } from "./hubRefresh";
import { hubTiles, hubsOfTile } from "./hubTiles";
import { placesPayload, readListRows } from "./placesService";
import { placesBody } from "./present";
import { hubRefreshStart } from "./refreshSchedule";
import {
  DETAIL_GATE_KEYS, countUnfetchedIn, detailGate, detailGateFrom, detailsAllowed, frozenSince, getTiles, isTileDue, tilePlaceStates,
  type DetailGate,
} from "./repo";
import { SNAPSHOT_DIRTY_PREFIX, SNAPSHOT_MAX_AGE_MS, SNAPSHOT_STALE_BOUND_MS } from "./snapshotDirty";

export { SNAPSHOT_MAX_AGE_MS, SNAPSHOT_STALE_BOUND_MS };

/**
 * R56 거점 스냅샷: Cron이 거점의 1000m 목록 응답 본문(지금 경로와 글자까지 같다)을 gzip으로 만들어 hub_snapshots(0007)에
 * 한 행으로 둔다. 엣지 캐시가 빈 요청은 그 한 행만 읽어 답한다 — 격자·격자-장소·목록 조회(수천 행)와 1MB 문자열 만들기를 하지 않는다.
 *
 * 주의: /api/places 본문이 바뀌면(PLACES_CACHE_VERSION을 올리는 변화, LIST_JSON_VERSION 변화 포함) 이 값을 올린다 —
 * 예전 판 스냅샷은 쓰지 않고 Cron이 다시 만든다.
 */
export const HUB_SNAPSHOT_VERSION = 2;

const MIN = 60_000;
/** 더러운(목록이 바뀐) 스냅샷은 만든 지 이만큼 지나면 다시 만든다 — 상세 갱신(평점·메뉴)이 목록에 늦게 보이는 최대 시간 */
export const SNAPSHOT_DIRTY_REBUILD_MS = 60 * MIN;
/** 깨끗한 스냅샷도 만료(만든 지 SNAPSHOT_MAX_AGE_MS) 이만큼 전에 새로 한다 (Cron 3번의 여유) */
export const SNAPSHOT_REFRESH_BEFORE_MS = 15 * MIN;
/** 스냅샷으로 답한 응답을 엣지에 두는 시간 — 다시 만든 스냅샷은 늦어도 이만큼 뒤에 보인다 (Cache API 삭제는 콜로 하나뿐이라 쓰지 않는다) */
export const SNAPSHOT_EDGE_CACHE_MS = 10 * MIN;
/** 저장하는 본문(base64)의 최대 길이. D1 행 한도(2MB) 안에 넉넉히 (동대문 gzip ≈ 0.2MB) */
export const SNAPSHOT_MAX_CHARS = 1_500_000;
const ENCODING = "gzip";
/**
 * 만들 수 없었던 거점(pending·tiles)과 끝나지 못한 첫 시도(CPU 초과로 죽은 실행)를 다시 보기까지 기다리는 시간.
 * 그동안 Cron은 그 거점의 격자-장소(수천 행)를 다시 읽지 않는다
 */
export const SNAPSHOT_SKIP_BACKOFF_MS = 20 * MIN;
/** 본문이 너무 커서(oversize) 건너뛴 거점 — 곧 줄지 않으므로 오래 기다린다 */
export const SNAPSHOT_OVERSIZE_BACKOFF_MS = 120 * MIN;
/** 끝나지 못한 시도가 이어질 때 두 배씩 늘리는 기다림의 상한 (죽은 실행은 사용량도 기록하지 못해서 이것이 헛읽기의 유일한 상한이다) */
export const SNAPSHOT_SKIP_MAX_BACKOFF_MS = 360 * MIN;
/** 쓸 수 있는 스냅샷이 있는 거점은 건너뛰어도 그 만료 이만큼 전 너머로는 기다리지 않는다 (스냅샷이 끊기지 않게 한 번은 다시 해 본다) */
export const SNAPSHOT_SKIP_EXPIRY_MARGIN_MS = 5 * MIN;
/** meta snapshot_skip:{hub} = {until, attempts}: until 전에는 고르지 않는다. attempts = 이어서 끝나지 못한 시도 수 (끝나면 0) */
export const SNAPSHOT_SKIP_PREFIX = "snapshot_skip:";
/** meta snapshot_full:{hub} = 마지막으로 본문을 다시 만든(새로 하기가 아닌) 시각 — 스냅샷 행과 같은 batch로 쓴다 */
export const SNAPSHOT_FULL_PREFIX = "snapshot_full:";
/**
 * 안전망: 마지막으로 다시 만든 지 이만큼 지난 스냅샷은 깨끗해도 새로 하지 않고 다시 만든다 — 새로 하기는 더러움 표시를 믿는데,
 * 표시를 빠뜨린 변화(손으로 고친 D1, 앞으로의 버그)가 있어도 하루 안에 바로잡히게. 거점마다 하루 한 번(공개 14곳이면 하루 14번)
 */
export const SNAPSHOT_FULL_REBUILD_MS = 24 * 60 * MIN;
/**
 * 쿨다운·frozen이 이만큼 안에 끝나면 만들지 않는다 (paused) — 그 스냅샷은 끝나는 때까지만 쓰여서(snapshotValidUntil) 무거운 만들기 값을 못 한다.
 * 예전 SNAPSHOT_MAX_AGE_MS(2시간)와 같은 값이라 쿨다운(30분) 동안 만들지 않는 것은 그대로다
 */
export const SNAPSHOT_PAUSED_MIN_LIFE_MS = 120 * MIN;
/** 기다려야 하는 건너뜀 — 데이터가 바뀌어야 풀리고 판단에 무거운 읽기가 드는 것 (paused·raced는 싸거나 곧 풀려서 기다리지 않는다) */
const BACKOFF_REASONS: ReadonlySet<SnapshotSkip> = new Set(["pending", "tiles", "oversize"]);
const META_SET = "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

type SkipState = { until: number; attempts: number };

/** 저장된 건너뜀 표시. 예전 형식(숫자 = until)도 읽는다 */
function parseSkip(raw: string | undefined): SkipState | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return { until: Number(raw), attempts: 0 };
  try {
    const o = JSON.parse(raw) as Partial<SkipState>;
    return typeof o.until === "number" && typeof o.attempts === "number" ? { until: o.until, attempts: o.attempts } : null;
  } catch {
    return null;
  }
}

/** 기다리는 시간: pending·tiles 20분, oversize 2시간, 끝나지 못한 시도는 n번째에 20분 × 2^(n−1) (최대 6시간) */
export function skipBackoffMs(reason: SnapshotSkip | "unfinished", attempts: number): number {
  if (reason === "oversize") return SNAPSHOT_OVERSIZE_BACKOFF_MS;
  if (reason !== "unfinished") return SNAPSHOT_SKIP_BACKOFF_MS;
  return Math.min(SNAPSHOT_SKIP_BACKOFF_MS * 2 ** Math.max(0, Math.min(attempts - 1, 10)), SNAPSHOT_SKIP_MAX_BACKOFF_MS);
}

type Base64Bytes = { toBase64(): string };
const fromBase64 = (s: string): Uint8Array => (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(s);

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 거점의 더러움 표시 (없으면 0) */
async function dirtyStamp(db: D1Database, hub: string): Promise<number> {
  const r = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(SNAPSHOT_DIRTY_PREFIX + hub).first<{ value: string }>();
  return Number(r?.value ?? 0) || 0;
}

export type SnapshotSkip = "pending" | "tiles" | "paused" | "oversize" | "raced";
export type SnapshotBuild =
  | { status: "built"; hub: string; places: number; bytes: number; gzipBytes: number }
  | { status: "skipped"; hub: string; reason: SnapshotSkip };

/** 표시가 읽은 값 그대로일 때만 쓴다 — 만드는 사이 바뀌었으면(더러워짐·무효화) 쓰지 않는다 */
const UPSERT = `INSERT INTO hub_snapshots (hub, version, built_at, source_at, encoding, etag, body)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
  WHERE COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?8), 0) = ?4
  ON CONFLICT(hub) DO UPDATE SET version = excluded.version, built_at = excluded.built_at, source_at = excluded.source_at,
    encoding = excluded.encoding, etag = excluded.etag, body = excluded.body`;
/** 다시 만든 시각 (UPSERT와 같은 조건 — 같은 batch라 스냅샷을 썼을 때만 쓴다) */
const FULL_MARK = `INSERT INTO meta (key, value) SELECT ?1, ?2
  WHERE COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?3), 0) = ?4
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/** 쿨다운·frozen이 끝나는(끝난) 시각들 — 그 시각에 detailsPaused·detailsFrozenSince가 바뀐다 (끝나는 것은 표시를 올리지 않는다) */
const gateEnds = (g: DetailGate): number[] => [g.blockedUntil, g.frozen?.until ?? 0].filter((t) => t > 0);

/** 지금까지 끝난 쿨다운·frozen 중 가장 늦은 끝 (없으면 0) — 그 전에 만든 스냅샷은 detailsPaused·detailsFrozenSince가 틀렸다 */
export const lastGateEnd = (g: DetailGate, now: number): number => Math.max(0, ...gateEnds(g).filter((t) => t <= now));

/** 쿨다운·frozen이 지금부터 ms 안에 끝나는가 (새로 걸리는 것은 recordPlaceBlock이 행을 지운다) */
function gateEndsWithin(gate: DetailGate, now: number, ms: number): boolean {
  return gateEnds(gate).some((t) => t > now && t < now + ms);
}

const neighbors = new Map<string, readonly Hub[]>();
/**
 * 거점 격자의 갱신 기준 시각 = 거점 1000m 격자를 덮는 거점들(자신 + 격자를 나눠 쓰는 거점)의 가장 늦은 갱신 시작 (R63).
 * 이 시각에 거점 격자 중 어떤 칸이 만료된다 (tileFreshFrom의 거점 단위 — 격자를 다시 읽지 않고 시계만으로 안다)
 */
export function hubTilesRefreshStart(hub: Hub, now: number): number {
  let hubs = neighbors.get(hub.id);
  if (!hubs) {
    const ids = new Set(hubTiles(hub).flatMap((k) => hubsOfTile(k)));
    hubs = [hub, ...HUBS.filter((h) => h.id !== hub.id && ids.has(h.id))];
    neighbors.set(hub.id, hubs);
  }
  return Math.max(...hubs.map((h) => hubRefreshStart(h, now)));
}

/**
 * Task 60: 스냅샷을 쓸 수 있는 끝 시각 (이 시각 전까지 쓴다). 셋 중 가장 이른 것:
 * - 만든(새로 한) 지 SNAPSHOT_MAX_AGE_MS(6시간)
 * - 거점 격자의 갱신 시작(R63 — 격자 만료) 전에 만들었으면 그 시작 + SNAPSHOT_STALE_BOUND_MS(2시간): 격자를 다시 모으기 전 목록이
 *   예전 상한보다 오래 나가지 않게. 다시 모은 뒤 표시가 그대로면 새로 하기가 built_at을 시작 뒤로 옮긴다
 * - 만든 뒤에 끝나는 쿨다운·frozen의 끝: 본문의 detailsPaused·detailsFrozenSince가 그때 틀려진다
 */
export function snapshotValidUntil(builtAt: number, hub: Hub, now: number, gate: DetailGate): number {
  let until = builtAt + SNAPSHOT_MAX_AGE_MS;
  const start = hubTilesRefreshStart(hub, now);
  if (builtAt < start) until = Math.min(until, start + SNAPSHOT_STALE_BOUND_MS);
  for (const end of gateEnds(gate)) if (builtAt < end) until = Math.min(until, end);
  return until;
}

/** 거점 1000m 격자 중 만료됐거나 수집하지 않은 격자가 있는가 (incompleteTiles·stale은 수집하는 지금 경로가 정한다) */
async function hubTilesDue(db: D1Database, hub: Hub, now: number): Promise<boolean> {
  const keys = tilesCoveringCircle({ lat: hub.lat, lng: hub.lng }, MAX_RADIUS);
  const tiles = await getTiles(db, keys);
  return keys.some((k) => isTileDue(k, tiles.get(k), now));
}

/**
 * 한 거점의 스냅샷을 만든다. 본문은 요청 경로(getPlaces)와 같은 읽기(readList)·같은 조립(placesPayload, placesBody)이다.
 * 만들지 않는 때 (지금 경로가 답한다):
 * - pending: 상세가 없는 가게가 있다 — 지금 경로가 보충을 시작하고 pending을 알린다 (pending 0이라고 말하는 스냅샷을 두지 않는다)
 * - tiles: 만료됐거나 수집하지 않은 격자가 있다 — incompleteTiles·stale은 수집하는 지금 경로가 정한다
 * - paused: 쿨다운·frozen이 SNAPSHOT_PAUSED_MIN_LIFE_MS 안에 끝난다 — 그 스냅샷은 끝날 때까지만 쓰여서(snapshotValidUntil) 만들 값을 못 한다
 * - oversize: 본문이 SNAPSHOT_MAX_CHARS를 넘는다
 * - raced: 만드는 사이 표시가 바뀌었다 (다음 실행이 다시 만든다)
 * 표시는 데이터보다 먼저 읽는다 — 읽은 뒤의 변화는 모두 표시를 바꾸므로 놓치지 않는다.
 */
export async function buildHubSnapshot(db: D1Database, hub: Hub, now: number): Promise<SnapshotBuild> {
  const skip = (reason: SnapshotSkip): SnapshotBuild => ({ status: "skipped", hub: hub.id, reason });
  const center = { lat: hub.lat, lng: hub.lng };
  const stamp = await dirtyStamp(db, hub.id);
  const gate = await detailGate(db);
  const frozen = frozenSince(gate, now);
  if (gateEndsWithin(gate, now, SNAPSHOT_PAUSED_MIN_LIFE_MS)) return skip("paused");

  if (await hubTilesDue(db, hub, now)) return skip("tiles");
  // pending은 목록(무거운 list_json)을 읽기 전에 본다
  const tileStates = await tilePlaceStates(db, tilesCoveringCircle(center, MAX_RADIUS));
  if (countUnfetchedIn(tileStates) > 0) return skip("pending");
  const rows = await readListRows(db, center, MAX_RADIUS, tileStates);
  // R63: 지금 경로와 같은 완료 기록 (기록이 바뀌면 recordHubRefreshed가 표시를 올려 다시 만든다)
  const refreshed = await readHubRefreshed(db, hub.id);

  const { items, ...meta } = placesPayload(center, MAX_RADIUS, rows, {
    pending: 0, incompleteTiles: 0, stale: false, detailsPaused: !detailsAllowed(gate, now), detailsFrozenSince: frozen,
    refreshedAt: refreshed?.start ?? null, refreshDay: hub.refreshDay,
  });
  const raw = new TextEncoder().encode(placesBody(meta, items));
  const gz = await gzip(raw);
  const body = (gz as unknown as Base64Bytes).toBase64();
  if (body.length > SNAPSHOT_MAX_CHARS) return skip("oversize");
  // 본문(gzip)에서 정하는 ETag — 같은 본문이면 다시 만들어도 같아서 화면의 저장본이 계속 304를 받는다
  const etag = `"${HUB_SNAPSHOT_VERSION}-${hub.id}-${await digestHex(gz)}"`;
  // 다시 만든 시각(SNAPSHOT_FULL_PREFIX — 새로 하기 안전망)도 같은 batch로 (D1 호출 수 그대로, 쓰기 +1행)
  const [r] = await db.batch([
    db.prepare(UPSERT).bind(hub.id, HUB_SNAPSHOT_VERSION, now, stamp, ENCODING, etag, body, SNAPSHOT_DIRTY_PREFIX + hub.id),
    db.prepare(FULL_MARK).bind(SNAPSHOT_FULL_PREFIX + hub.id, String(now), SNAPSHOT_DIRTY_PREFIX + hub.id, stamp),
  ]);
  if (!Number(r.meta?.changes)) return skip("raced");
  return { status: "built", hub: hub.id, places: items.length, bytes: raw.byteLength, gzipBytes: gz.byteLength };
}

/**
 * 표시가 만든 때 그대로이고 행도 그대로일 때만 만든 시각을 바꾼다 (바꾸는 사이 더러워졌거나 다시 만들어졌으면 0행).
 * 안전망: 마지막으로 다시 만든 시각(snapshot_full:{hub})이 ?8(= 지금 − SNAPSHOT_FULL_REBUILD_MS)보다 뒤일 때만 — 지났거나 기록이 없으면
 * 0행이라 만들기 경로로 간다 (D1 호출을 늘리지 않으려고 같은 문장에서 본다 — 할 일 없는 실행의 읽기는 그대로)
 */
const RENEW = `UPDATE hub_snapshots SET built_at = ?5
  WHERE hub = ?1 AND version = ?2 AND built_at = ?3 AND source_at = ?4
    AND COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?6), 0) = ?4
    AND COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = ?7), 0) > ?8`;

/**
 * 깨끗한 스냅샷 새로 하기 (Task 56): 표시가 만든 때 그대로(source_at)면 본문도 그대로다 — 본문을 바꾸는 쓰기(상세 저장·실패 기록,
 * 격자 ID 변경, R63 완료 기록)는 같은 batch에서 표시를 올리고, 새 ID와 쿨다운 시작은 행을 지운다. 그래서 목록(수천 행)을 다시 읽고
 * gzip하지 않고 built_at만 지금으로 바꾼다 (D1 2번, 읽기 ~60행). 시간이 바꾸는 것은 만들 때와 같이 다시 본다: 만료 격자
 * (R63 갱신 요일 — 있으면 "tiles": 다시 모은 뒤에 새로 한다). 쿨다운·frozen은 보지 않는다 — 걸리면 행이 지워지고, 그 동안 만든 것은
 * 끝나는 때까지만 쓴다(snapshotValidUntil — 새로 해도 그대로). 바꾸는 사이 표시가 바뀌었거나 안전망(마지막으로 다시 만든 지
 * SNAPSHOT_FULL_REBUILD_MS가 지났거나 기록이 없음)이면 "raced" — 부르는 쪽이 만들기 경로로 간다(건너뜀·다시 만들기).
 */
async function renewHubSnapshot(
  db: D1Database, hub: Hub, row: { built_at: number; source_at: number }, now: number,
): Promise<RenewResult> {
  if (await hubTilesDue(db, hub, now)) return "tiles";
  const r = await db
    .prepare(RENEW)
    .bind(
      hub.id, HUB_SNAPSHOT_VERSION, row.built_at, row.source_at, now, SNAPSHOT_DIRTY_PREFIX + hub.id, SNAPSHOT_FULL_PREFIX + hub.id,
      now - SNAPSHOT_FULL_REBUILD_MS,
    )
    .run();
  return Number(r.meta?.changes) > 0 ? "renewed" : "raced";
}
/** tiles: 만료 격자, raced: 표시·행이 바뀌었거나 안전망이 지남 */
type RenewResult = "renewed" | "tiles" | "raced";

/**
 * 한 실행이 해 보는 후보 수 (만료 격자로 못 하는 거점 뒤의 거점도 하게 — 만료 격자 판단은 격자 상태 ~60행이라 싸다).
 * 무거운 만들기는 그래도 실행마다 많아야 한 번이다 (만료 격자가 아닌 결과에서 멈춘다)
 */
const SNAPSHOT_TRIES = 3;

/**
 * 읽은 스냅샷. body가 null이면 If-None-Match와 ETag가 같아서 본문 열을 받지 않았다 (304).
 * validUntil: 이 스냅샷을 쓸 수 있는 끝 시각 (snapshotValidUntil — 엣지에 두는 시간도 이것을 넘지 않는다)
 */
export type Snapshot = { etag: string; builtAt: number; validUntil: number; notModified: boolean; body: Uint8Array | null };

/** If-None-Match(약한 비교)에 이 ETag(따옴표 포함, W/ 없이 저장)가 있는가 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  const h = header?.trim() ?? "";
  return h !== "" && (h === "*" || h.includes(etag));
}

/**
 * 엣지 캐시 미스에서 거점 스냅샷 한 행을 읽는다 (D1 1행 + 쿨다운·frozen meta 2행 — 같은 질의). 지금 판·gzip이고
 * 쓸 수 있는 끝(snapshotValidUntil) 전일 때만, 아니면 null.
 * If-None-Match가 ETag와 같으면 본문 열(BLOB 대신 base64 텍스트 — D1은 BLOB을 숫자 배열로 준다)을 받지 않는다.
 */
export async function readHubSnapshot(
  db: D1Database, hub: Hub, now: number, ifNoneMatch: string | undefined,
): Promise<Snapshot | null> {
  // 판·인코딩·나이·격자 만료(시계로 아는 것)는 WHERE에서 걸러서 쓸 수 없는 행은 본문(base64)을 받지 않는다.
  // 끝난 쿨다운·frozen은 Cron이 5분 안에 행을 지운다 — 그 사이의 드문 행만 받아서 버린다
  const start = hubTilesRefreshStart(hub, now);
  const minBuiltAt = Math.max(now - SNAPSHOT_MAX_AGE_MS + 1, now >= start + SNAPSHOT_STALE_BOUND_MS ? start : -Infinity);
  const [blockedKey, modeKey] = DETAIL_GATE_KEYS;
  const r = await db
    .prepare(
      `SELECT built_at, etag, CASE WHEN ?2 = '*' OR instr(?2, etag) > 0 THEN NULL ELSE body END AS body,
         (SELECT value FROM meta WHERE key = ?6) AS blocked, (SELECT value FROM meta WHERE key = ?7) AS mode
       FROM hub_snapshots
       WHERE hub = ?1 AND version = ?3 AND encoding = '${ENCODING}' AND built_at BETWEEN ?4 AND ?5`,
    )
    .bind(hub.id, ifNoneMatch?.trim() || "", HUB_SNAPSHOT_VERSION, minBuiltAt, now, blockedKey, modeKey)
    .first<{ built_at: number; etag: string; body: string | null; blocked: string | null; mode: string | null }>();
  if (!r) return null;
  const gate = detailGateFrom((k) => (k === blockedKey ? r.blocked : k === modeKey ? r.mode : null) ?? undefined);
  const validUntil = snapshotValidUntil(r.built_at, hub, now, gate);
  if (validUntil <= now) return null;
  const base = { etag: r.etag, builtAt: r.built_at, validUntil };
  if (r.body === null) return { ...base, notModified: true, body: null };
  return { ...base, notModified: false, body: fromBase64(r.body) };
}

/** 스냅샷 응답을 엣지에 둘 시간: SNAPSHOT_EDGE_CACHE_MS, 스냅샷을 쓸 수 있는 남은 시간(validUntil까지)이 더 짧으면 그만큼 (초 단위, 최소 1초) */
export function snapshotEdgeTtlMs(validUntil: number, now: number): number {
  const left = validUntil - now;
  return Math.max(1000, Math.floor(Math.min(SNAPSHOT_EDGE_CACHE_MS, left) / 1000) * 1000);
}

/**
 * Accept-Encoding이 gzip을 받는가 (없으면 받지 않는 것으로 친다 — curl 등). q=0은 거절.
 * 운영에서는 Cloudflare가 Worker로 오는 Accept-Encoding을 바꿀 수 있어서, 부르는 쪽이 원래 값(request.cf.clientAcceptEncoding)을 먼저 넘긴다
 */
export function acceptsGzip(header: string | undefined): boolean {
  let star = false;
  for (const part of (header ?? "").toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";").map((x) => x.trim());
    const q = params.find((p) => p.startsWith("q="));
    const ok = q === undefined || Number(q.slice(2)) > 0;
    if (name === "gzip") return ok;
    if (name === "*") star = ok;
  }
  return star;
}

export type ResponseSource = "edge" | "snapshot" | "live";

/**
 * 스냅샷(gzip) 본문 응답. gzip을 받는 화면에는 그대로(encodeBody: "manual" — Workers가 다시 압축하지 않는다),
 * 아니면 DecompressionStream으로 풀어서 준다. 브라우저 응답은 언제나 no-store이고 ETag(약한)를 싣는다
 */
export function snapshotResponse(
  body: Uint8Array | ReadableStream, etag: string, gzipOk: boolean, source: ResponseSource,
): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json", "cache-control": "no-store", etag: `W/${etag}`, "x-mmj-source": source,
    // 같은 주소가 Accept-Encoding에 따라 gzip 바이트이거나 풀린 JSON이다
    vary: "accept-encoding",
  };
  if (gzipOk) return new Response(body, { headers: { ...headers, "content-encoding": "gzip" }, encodeBody: "manual" });
  const stream = body instanceof Uint8Array ? new Blob([body]).stream() : body;
  return new Response(stream.pipeThrough(new DecompressionStream("gzip")), { headers });
}

export const notModifiedResponse = (etag: string, source: ResponseSource) =>
  new Response(null, { status: 304, headers: { etag: `W/${etag}`, "cache-control": "no-store", "x-mmj-source": source } });

/** renewed: 깨끗한 스냅샷의 만든 시각만 새로 했다 (renewHubSnapshot) */
export type SnapshotRun = SnapshotBuild | { status: "idle" } | { status: "renewed"; hub: string };

type MetaRow = { hub: string; version: number; built_at: number; source_at: number };

/**
 * R56 Cron: 실행마다 무거운 만들기는 많아야 한 거점 (CPU·D1 읽기를 실행마다 나눈다).
 * 처음에 넘겨받은 거점 목록(hubs)에 없는 거점, SNAPSHOT_MAX_AGE_MS가 지난(또는 미래 시각) 행, 끝난 쿨다운·frozen 전에 만든 행
 * (lastGateEnd — 본문의 detailsPaused·detailsFrozenSince가 틀렸다; 새로 하기로 되살리지 않게)을 지운다.
 * 고르는 순서: 쓸 수 있는 스냅샷이 없는 거점(없음·판이 다름·쓸 수 있는 끝이 지남 — 넘겨받은 순서 = 실행마다 돌아가는 hubOrder) →
 * 만든 지 SNAPSHOT_MAX_AGE_MS − SNAPSHOT_REFRESH_BEFORE_MS가 된 것, 거점 격자의 갱신 시작(R63) 전에 만든 것, 또는 더러운데
 * (표시 ≠ source_at) 만든 지 SNAPSHOT_DIRTY_REBUILD_MS가 지난 것 — 쓸 수 있는 끝(snapshotValidUntil)이 이른 것부터 (Task 60:
 * 끊길 것부터 — 갱신 시작 전에 만든 것은 시작 + 2시간에 끊긴다).
 * 고른 것이 깨끗한(표시 = source_at) 스냅샷이면 먼저 새로 한다(renewHubSnapshot — 만든 시각만, 무거운 읽기 없음).
 * 마지막으로 다시 만든 지 SNAPSHOT_FULL_REBUILD_MS(24시간)가 지났으면(기록이 없어도) 깨끗해도 그때 고르고 다시 만든다 (안전망 —
 * Task 60: 새로 할 때(만료 15분 전)를 기다리지 않는다. 쓰는 시간이 6시간이라 기다리면 안전망이 30시간 가까이로 늘어난다).
 * 만료 격자(새로 하기의 "tiles"·만들기의 건너뜀 tiles)면 그 거점은 기다리게 하고 다음 후보를 본다 (많아야 SNAPSHOT_TRIES곳 —
 * 갱신 요일 아침에 격자를 다시 모으는 동안 :x7을 헛쓰지 않게). 다른 결과(만듦·새로 함·다른 건너뜀)에서 멈춘다.
 * snapshot_skip:{hub}의 until이 지금보다 뒤인 거점은 고르지 않는다 (skipBackoffMs).
 * 만들기 전에 {until: 지금 + 기다림, attempts: 이전 + 1}을 써 둔다 — 실행이 CPU 초과로 죽으면 표시가 남고, 이어서 죽을수록
 * 기다림이 두 배씩(20 → 40 → 80분 … 최대 6시간) 는다. 만들었거나 기다릴 필요가 없는 건너뜀(paused·raced)이면 지우고,
 * pending·tiles·oversize면 그 사유의 기다림과 attempts 0으로 다시 쓴다. 쓸 수 있는 스냅샷이 있는 거점은 그 끝 5분 전 너머로 기다리지 않는다.
 * 할 일이 없으면 idle (스냅샷 메타 ≤ 거점 수 행 + meta ≤ 3 × 거점 수 + 2행만 읽는다).
 * renewOnly(둘째 트리거의 :x2 — Task 56 Fix 2): 무거운 만들기는 하지 않는다. 깨끗하고 새로 할 때가 된(만료가 가깝거나 격자 갱신
 * 시작 전에 만든) 스냅샷 중 안전망이 지나지 않은 것을 끝이 이른 순으로 많아야 SNAPSHOT_TRIES곳 새로 해 보고, 없으면 idle.
 * 없는·판이 다른·더러운·안전망이 지난 스냅샷은 :x7(만들기, 시간당 6번 — 예전 상한)에 맡긴다.
 */
export async function maintainSnapshots(
  db: D1Database, hubs: Hub[], now: number, opts: { renewOnly?: boolean } = {},
): Promise<SnapshotRun> {
  if (hubs.length === 0) {
    await db.prepare("DELETE FROM hub_snapshots").run();
    return { status: "idle" };
  }
  const marks = hubs.map(() => "?").join(",");
  // 표시·건너뜀·다시 만든 시각과 쿨다운·frozen을 한 번에 (지우기 전에 — 끝난 게이트 전에 만든 행을 같이 지운다)
  const stamps = await db
    .prepare(`SELECT key, value FROM meta WHERE key IN (${marks}, ${marks}, ${marks}, ?, ?)`)
    .bind(
      ...hubs.map((h) => SNAPSHOT_DIRTY_PREFIX + h.id), ...hubs.map((h) => SNAPSHOT_SKIP_PREFIX + h.id),
      ...hubs.map((h) => SNAPSHOT_FULL_PREFIX + h.id), ...DETAIL_GATE_KEYS,
    )
    .all<{ key: string; value: string }>();
  const metaValue = (key: string) => stamps.results.find((x) => x.key === key)?.value;
  const gate = detailGateFrom(metaValue);
  // 행은 거점 수만큼뿐이라 모두 읽고(지울 것도 여기서 안다), 지울 것이 있을 때만 지운다 — 할 일 없는 실행의 읽기를 늘리지 않게
  const all = await db.prepare("SELECT hub, version, built_at, source_at FROM hub_snapshots").all<MetaRow>();
  const ids = new Set(hubs.map((h) => h.id));
  const gateEnd = lastGateEnd(gate, now);
  const gone = (m: MetaRow) => !ids.has(m.hub) || m.built_at <= now - SNAPSHOT_MAX_AGE_MS || m.built_at > now || m.built_at < gateEnd;
  const doomed = all.results.filter(gone).map((m) => m.hub);
  if (doomed.length > 0) {
    // 같은 조건을 다시 건다 — 읽은 뒤 다시 만들어진 행은 지우지 않는다
    await db
      .prepare(
        `DELETE FROM hub_snapshots WHERE hub IN (SELECT value FROM json_each(?1))
           AND (built_at <= ?2 OR built_at > ?3 OR built_at < ?4 OR hub NOT IN (SELECT value FROM json_each(?5)))`,
      )
      .bind(JSON.stringify(doomed), now - SNAPSHOT_MAX_AGE_MS, now, gateEnd, JSON.stringify([...ids]))
      .run();
  }
  const metaNum = (key: string) => Number(metaValue(key) ?? 0) || 0;
  const ctx: SelectCtx = { now, gate, metas: all.results.filter((m) => !gone(m)), metaNum, metaValue };
  if (opts.renewOnly) return renewOnly(db, hubs, ctx);

  const candidates: { hub: Hub; rank: number; until: number }[] = [];
  for (const hub of hubs) {
    if (waiting(hub, ctx)) continue;
    const m = ctx.metas.find((x) => x.hub === hub.id);
    if (!m || m.version !== HUB_SNAPSHOT_VERSION) {
      candidates.push({ hub, rank: 0, until: -Infinity });
      continue;
    }
    const until = snapshotValidUntil(m.built_at, hub, now, gate);
    if (until <= now) {
      candidates.push({ hub, rank: 0, until });
      continue;
    }
    const dirty = metaNum(SNAPSHOT_DIRTY_PREFIX + hub.id) !== m.source_at && now - m.built_at >= SNAPSHOT_DIRTY_REBUILD_MS;
    if (dirty || renewDue(m, hub, now) || !fullFresh(hub, ctx)) candidates.push({ hub, rank: 1, until });
  }
  if (candidates.length === 0) return { status: "idle" };
  // 정렬은 안정적이다 — 같으면 넘겨받은 순서
  candidates.sort((a, b) => a.rank - b.rank || a.until - b.until);
  let last: SnapshotRun = { status: "idle" };
  for (const c of candidates.slice(0, SNAPSHOT_TRIES)) {
    last = await maintainHub(db, c.hub, ctx);
    if (!(last.status === "skipped" && last.reason === "tiles")) return last;
  }
  return last;
}

type SelectCtx = {
  now: number;
  gate: DetailGate;
  metas: MetaRow[];
  metaNum: (key: string) => number;
  metaValue: (key: string) => string | undefined;
};

/** 건너뜀 표시로 기다리는 중인가 */
const waiting = (hub: Hub, ctx: SelectCtx): boolean => {
  const skip = parseSkip(ctx.metaValue(SNAPSHOT_SKIP_PREFIX + hub.id));
  return skip !== null && skip.until > ctx.now;
};

/** 안전망: 마지막으로 다시 만든 지 SNAPSHOT_FULL_REBUILD_MS 안인가 (기록이 없으면 아니다 — 새로 하지 않고 다시 만든다) */
const fullFresh = (hub: Hub, ctx: SelectCtx): boolean => ctx.now - ctx.metaNum(SNAPSHOT_FULL_PREFIX + hub.id) < SNAPSHOT_FULL_REBUILD_MS;

/** 새로 할 때가 됐는가: 만든 지 SNAPSHOT_MAX_AGE_MS − SNAPSHOT_REFRESH_BEFORE_MS, 또는 거점 격자의 갱신 시작 전에 만들었다 */
const renewDue = (m: MetaRow, hub: Hub, now: number): boolean =>
  now - m.built_at >= SNAPSHOT_MAX_AGE_MS - SNAPSHOT_REFRESH_BEFORE_MS || m.built_at < hubTilesRefreshStart(hub, now);

/** 고른 한 거점: 깨끗하면 새로 하기, 아니면(또는 새로 할 수 없으면) 만들기 — 건너뜀 표시를 함께 다룬다 */
async function maintainHub(db: D1Database, hub: Hub, ctx: SelectCtx): Promise<SnapshotRun> {
  const { now } = ctx;
  const skipKey = SNAPSHOT_SKIP_PREFIX + hub.id;
  const row = ctx.metas.find((x) => x.hub === hub.id && x.version === HUB_SNAPSHOT_VERSION && x.built_at <= now);
  // 쓸 수 있는 스냅샷이 있으면 그 끝 SNAPSHOT_SKIP_EXPIRY_MARGIN_MS 전 너머로는 기다리지 않는다 (스냅샷이 끊기지 않게)
  const until = row ? snapshotValidUntil(row.built_at, hub, now, ctx.gate) : 0;
  const skipUntil = (wait: number) => (until > now ? Math.min(now + wait, until - SNAPSHOT_SKIP_EXPIRY_MARGIN_MS) : now + wait);
  const setSkip = (s: SkipState) => db.prepare(META_SET).bind(skipKey, JSON.stringify(s)).run();
  const hadSkip = ctx.metaValue(skipKey) !== undefined;
  if (row && row.source_at === ctx.metaNum(SNAPSHOT_DIRTY_PREFIX + hub.id)) {
    const renewed = await renewHubSnapshot(db, hub, row, now);
    if (renewed === "renewed") {
      if (hadSkip) await db.prepare("DELETE FROM meta WHERE key = ?").bind(skipKey).run();
      return { status: "renewed", hub: hub.id };
    }
    // 만료 격자: 만들기도 같은 이유로 건너뛴다 — 다시 읽지 않고 그 기다림을 쓴다
    if (renewed === "tiles") {
      await setSkip({ until: skipUntil(skipBackoffMs("tiles", 0)), attempts: 0 });
      return { status: "skipped", hub: hub.id, reason: "tiles" };
    }
  }
  // 시작 표시: 이번 시도가 끝나지 못하면(CPU 초과로 죽음) 이 값이 남는다 — 이어서 죽을수록 오래 기다린다
  const attempts = (parseSkip(ctx.metaValue(skipKey))?.attempts ?? 0) + 1;
  await setSkip({ until: skipUntil(skipBackoffMs("unfinished", attempts)), attempts });
  const r = await buildHubSnapshot(db, hub, now);
  if (r.status === "skipped" && BACKOFF_REASONS.has(r.reason)) {
    await setSkip({ until: skipUntil(skipBackoffMs(r.reason, 0)), attempts: 0 });
  } else {
    await db.prepare("DELETE FROM meta WHERE key = ?").bind(skipKey).run();
  }
  return r;
}

/**
 * :x2 새로 하기만 (maintainSnapshots renewOnly): 후보 = 건너뜀 표시로 기다리는 중이 아니고, 지금 판의 스냅샷이 깨끗하고
 * (표시 = source_at) 새로 할 때가 된(renewDue) 거점 중 안전망이 지나지 않은 것(fullFresh — 다시 만든 시각은 처음 meta 읽기에
 * 함께 읽는다). 쓸 수 있는 끝이 이른 순으로 많아야 SNAPSHOT_TRIES곳 해 본다
 */
async function renewOnly(db: D1Database, hubs: Hub[], ctx: SelectCtx): Promise<SnapshotRun> {
  const { now } = ctx;
  const candidates = hubs
    .flatMap((hub) => {
      if (waiting(hub, ctx)) return [];
      const m = ctx.metas.find((x) => x.hub === hub.id && x.version === HUB_SNAPSHOT_VERSION && x.built_at <= now);
      if (!m || m.source_at !== ctx.metaNum(SNAPSHOT_DIRTY_PREFIX + hub.id) || !renewDue(m, hub, now) || !fullFresh(hub, ctx)) return [];
      return [{ hub, row: m, until: snapshotValidUntil(m.built_at, hub, now, ctx.gate) }];
    })
    .sort((a, b) => a.until - b.until)
    .slice(0, SNAPSHOT_TRIES);
  for (const c of candidates) {
    if ((await renewHubSnapshot(db, c.hub, c.row, now)) === "renewed") {
      const skipKey = SNAPSHOT_SKIP_PREFIX + c.hub.id;
      if (ctx.metaValue(skipKey) !== undefined) await db.prepare("DELETE FROM meta WHERE key = ?").bind(skipKey).run();
      return { status: "renewed", hub: c.hub.id };
    }
  }
  return { status: "idle" };
}
