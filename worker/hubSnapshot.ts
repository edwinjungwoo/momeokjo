import { MAX_RADIUS } from "../shared/constants";
import { tilesCoveringCircle } from "../shared/geo";
import type { Hub } from "../shared/hubs";
import { readHubRefreshed } from "./hubRefresh";
import { placesPayload, readListRows } from "./placesService";
import { placesBody } from "./present";
import { countUnfetchedIn, detailGate, detailsAllowed, frozenSince, getTiles, isTileDue, tilePlaceStates } from "./repo";
import { SNAPSHOT_DIRTY_PREFIX } from "./snapshotDirty";

/**
 * R56 거점 스냅샷: Cron이 거점의 1000m 목록 응답 본문(지금 경로와 글자까지 같다)을 gzip으로 만들어 hub_snapshots(0007)에
 * 한 행으로 둔다. 엣지 캐시가 빈 요청은 그 한 행만 읽어 답한다 — 격자·격자-장소·목록 조회(수천 행)와 1MB 문자열 만들기를 하지 않는다.
 *
 * 주의: /api/places 본문이 바뀌면(PLACES_CACHE_VERSION을 올리는 변화, LIST_JSON_VERSION 변화 포함) 이 값을 올린다 —
 * 예전 판 스냅샷은 쓰지 않고 Cron이 다시 만든다.
 */
export const HUB_SNAPSHOT_VERSION = 2;

const MIN = 60_000;
/** 만든 지 이만큼 지난 스냅샷은 쓰지 않는다 (Cron이 멈춰도 오래된 목록이 계속 나가지 않게) */
export const SNAPSHOT_MAX_AGE_MS = 120 * MIN;
/** 더러운(목록이 바뀐) 스냅샷은 만든 지 이만큼 지나면 다시 만든다 — 상세 갱신(평점·메뉴)이 목록에 늦게 보이는 최대 시간 */
export const SNAPSHOT_DIRTY_REBUILD_MS = 60 * MIN;
/** 깨끗한 스냅샷도 만료 이만큼 전에 다시 만든다 (Cron 3번의 여유) */
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

/**
 * 한 거점의 스냅샷을 만든다. 본문은 요청 경로(getPlaces)와 같은 읽기(readList)·같은 조립(placesPayload, placesBody)이다.
 * 만들지 않는 때 (지금 경로가 답한다):
 * - pending: 상세가 없는 가게가 있다 — 지금 경로가 보충을 시작하고 pending을 알린다 (pending 0이라고 말하는 스냅샷을 두지 않는다)
 * - tiles: 만료됐거나 수집하지 않은 격자가 있다 — incompleteTiles·stale은 수집하는 지금 경로가 정한다
 * - paused: 쿨다운·frozen이 쓰는 동안(SNAPSHOT_MAX_AGE_MS) 안에 끝난다 — detailsPaused·detailsFrozenSince가 틀린 채로 남지 않게
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
  const ends = [gate.blockedUntil > now ? gate.blockedUntil : null, frozen !== null ? gate.frozen!.until : null];
  if (ends.some((t) => t !== null && t < now + SNAPSHOT_MAX_AGE_MS)) return skip("paused");

  const keys = tilesCoveringCircle(center, MAX_RADIUS);
  const tiles = await getTiles(db, keys);
  if (keys.some((k) => isTileDue(k, tiles.get(k), now))) return skip("tiles");
  // pending은 목록(무거운 list_json)을 읽기 전에 본다
  const tileStates = await tilePlaceStates(db, keys);
  if (countUnfetchedIn(tileStates) > 0) return skip("pending");
  const rows = await readListRows(db, center, MAX_RADIUS, tileStates);
  // R63: 지금 경로와 같은 완료 기록 (기록이 바뀌면 recordHubRefreshed가 표시를 올려 다시 만든다)
  const refreshed = await readHubRefreshed(db, hub.id);

  const { items, ...meta } = placesPayload(center, MAX_RADIUS, rows, {
    pending: 0, incompleteTiles: 0, stale: false, detailsPaused: !detailsAllowed(gate, now), detailsFrozenSince: frozen,
    refreshedAt: refreshed?.at ?? null, refreshDay: hub.refreshDay,
  });
  const raw = new TextEncoder().encode(placesBody(meta, items));
  const gz = await gzip(raw);
  const body = (gz as unknown as Base64Bytes).toBase64();
  if (body.length > SNAPSHOT_MAX_CHARS) return skip("oversize");
  // 본문(gzip)에서 정하는 ETag — 같은 본문이면 다시 만들어도 같아서 화면의 저장본이 계속 304를 받는다
  const etag = `"${HUB_SNAPSHOT_VERSION}-${hub.id}-${await digestHex(gz)}"`;
  const r = await db
    .prepare(UPSERT)
    .bind(hub.id, HUB_SNAPSHOT_VERSION, now, stamp, ENCODING, etag, body, SNAPSHOT_DIRTY_PREFIX + hub.id)
    .run();
  if (!Number(r.meta?.changes)) return skip("raced");
  return { status: "built", hub: hub.id, places: items.length, bytes: raw.byteLength, gzipBytes: gz.byteLength };
}

/** 읽은 스냅샷. body가 null이면 If-None-Match와 ETag가 같아서 본문 열을 받지 않았다 (304) */
export type Snapshot = { etag: string; builtAt: number; notModified: boolean; body: Uint8Array | null };

/** If-None-Match(약한 비교)에 이 ETag(따옴표 포함, W/ 없이 저장)가 있는가 */
export function etagMatches(header: string | undefined, etag: string): boolean {
  const h = header?.trim() ?? "";
  return h !== "" && (h === "*" || h.includes(etag));
}

/**
 * 엣지 캐시 미스에서 거점 스냅샷 한 행을 읽는다 (D1 1행). 지금 판·gzip·SNAPSHOT_MAX_AGE_MS 안일 때만, 아니면 null.
 * If-None-Match가 ETag와 같으면 본문 열(BLOB 대신 base64 텍스트 — D1은 BLOB을 숫자 배열로 준다)을 받지 않는다.
 */
export async function readHubSnapshot(
  db: D1Database, hub: string, now: number, ifNoneMatch: string | undefined,
): Promise<Snapshot | null> {
  // 판·인코딩·나이를 WHERE에서 걸러서 쓸 수 없는 행은 본문(base64)을 받지 않는다
  const r = await db
    .prepare(
      `SELECT built_at, etag, CASE WHEN ?2 = '*' OR instr(?2, etag) > 0 THEN NULL ELSE body END AS body
       FROM hub_snapshots
       WHERE hub = ?1 AND version = ?3 AND encoding = '${ENCODING}' AND built_at BETWEEN ?4 AND ?5`,
    )
    .bind(hub, ifNoneMatch?.trim() || "", HUB_SNAPSHOT_VERSION, now - SNAPSHOT_MAX_AGE_MS + 1, now)
    .first<{ built_at: number; etag: string; body: string | null }>();
  if (!r) return null;
  if (r.body === null) return { etag: r.etag, builtAt: r.built_at, notModified: true, body: null };
  return { etag: r.etag, builtAt: r.built_at, notModified: false, body: fromBase64(r.body) };
}

/** 스냅샷 응답을 엣지에 둘 시간: SNAPSHOT_EDGE_CACHE_MS, 스냅샷을 쓸 수 있는 남은 시간이 더 짧으면 그만큼 (초 단위, 최소 1초) */
export function snapshotEdgeTtlMs(builtAt: number, now: number): number {
  const left = builtAt + SNAPSHOT_MAX_AGE_MS - now;
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

export type SnapshotRun = SnapshotBuild | { status: "idle" };

/**
 * R56 Cron: 실행마다 거점 하나만 만든다 (CPU·D1 읽기를 실행마다 나눈다).
 * 고르는 순서: 스냅샷이 없거나 판이 다른 거점(넘겨받은 순서 = 실행마다 돌아가는 hubOrder) →
 * 만료 SNAPSHOT_REFRESH_BEFORE_MS 전이 된 것, 또는 더러운데(표시 ≠ source_at) 만든 지 SNAPSHOT_DIRTY_REBUILD_MS가 지난 것 중 가장 오래된 것.
 * snapshot_skip:{hub}의 until이 지금보다 뒤인 거점은 고르지 않는다 (skipBackoffMs).
 * 만들기 전에 {until: 지금 + 기다림, attempts: 이전 + 1}을 써 둔다 — 실행이 CPU 초과로 죽으면 표시가 남고, 이어서 죽을수록
 * 기다림이 두 배씩(20 → 40 → 80분 … 최대 6시간) 는다. 만들었거나 기다릴 필요가 없는 건너뜀(paused·raced)이면 지우고,
 * pending·tiles·oversize면 그 사유의 기다림과 attempts 0으로 다시 쓴다. 쓸 수 있는 스냅샷이 있는 거점은 그 만료 5분 전 너머로 기다리지 않는다.
 * 처음에 넘겨받은 거점 목록(hubs)에 없는 거점과 SNAPSHOT_MAX_AGE_MS가 지난(또는 미래 시각) 행을 지운다.
 * 할 일이 없으면 idle (스냅샷 메타 ≤ 거점 수 행 + 표시 ≤ 2 × 거점 수 행만 읽는다).
 */
export async function maintainSnapshots(db: D1Database, hubs: Hub[], now: number): Promise<SnapshotRun> {
  await db
    .prepare("DELETE FROM hub_snapshots WHERE built_at <= ? OR built_at > ? OR hub NOT IN (SELECT value FROM json_each(?))")
    .bind(now - SNAPSHOT_MAX_AGE_MS, now, JSON.stringify(hubs.map((h) => h.id)))
    .run();
  if (hubs.length === 0) return { status: "idle" };
  const marks = hubs.map(() => "?").join(",");
  const metas = await db
    .prepare(`SELECT hub, version, built_at, source_at FROM hub_snapshots WHERE hub IN (${marks})`)
    .bind(...hubs.map((h) => h.id))
    .all<{ hub: string; version: number; built_at: number; source_at: number }>();
  const stamps = await db
    .prepare(`SELECT key, value FROM meta WHERE key IN (${marks}, ${marks})`)
    .bind(...hubs.map((h) => SNAPSHOT_DIRTY_PREFIX + h.id), ...hubs.map((h) => SNAPSHOT_SKIP_PREFIX + h.id))
    .all<{ key: string; value: string }>();
  const metaNum = (key: string) => Number(stamps.results.find((x) => x.key === key)?.value ?? 0) || 0;
  let pick: { hub: Hub; rank: number; builtAt: number } | null = null;
  for (const hub of hubs) {
    const m = metas.results.find((x) => x.hub === hub.id);
    const skip = parseSkip(stamps.results.find((x) => x.key === SNAPSHOT_SKIP_PREFIX + hub.id)?.value);
    if (skip && skip.until > now) continue;
    const stamp = metaNum(SNAPSHOT_DIRTY_PREFIX + hub.id);
    let rank: number | null = null;
    if (!m || m.version !== HUB_SNAPSHOT_VERSION) rank = 0;
    else {
      const age = now - m.built_at;
      const expiring = age >= SNAPSHOT_MAX_AGE_MS - SNAPSHOT_REFRESH_BEFORE_MS || age < 0;
      const dirty = stamp !== m.source_at && age >= SNAPSHOT_DIRTY_REBUILD_MS;
      if (expiring || dirty) rank = 1;
    }
    if (rank === null) continue;
    const builtAt = m?.built_at ?? -Infinity;
    if (!pick || rank < pick.rank || (rank === pick.rank && builtAt < pick.builtAt)) pick = { hub, rank, builtAt };
  }
  if (!pick) return { status: "idle" };
  const hubId = pick.hub.id;
  const skipKey = SNAPSHOT_SKIP_PREFIX + hubId;
  // 쓸 수 있는 스냅샷이 있으면 그 만료 SNAPSHOT_SKIP_EXPIRY_MARGIN_MS 전 너머로는 기다리지 않는다 (스냅샷이 끊기지 않게)
  const valid = metas.results.find((x) => x.hub === hubId && x.version === HUB_SNAPSHOT_VERSION && x.built_at <= now);
  const skipUntil = (wait: number) =>
    valid ? Math.min(now + wait, valid.built_at + SNAPSHOT_MAX_AGE_MS - SNAPSHOT_SKIP_EXPIRY_MARGIN_MS) : now + wait;
  const setSkip = (s: SkipState) => db.prepare(META_SET).bind(skipKey, JSON.stringify(s)).run();
  // 시작 표시: 이번 시도가 끝나지 못하면(CPU 초과로 죽음) 이 값이 남는다 — 이어서 죽을수록 오래 기다린다
  const attempts = (parseSkip(stamps.results.find((x) => x.key === skipKey)?.value)?.attempts ?? 0) + 1;
  await setSkip({ until: skipUntil(skipBackoffMs("unfinished", attempts)), attempts });
  const r = await buildHubSnapshot(db, pick.hub, now);
  if (r.status === "skipped" && BACKOFF_REASONS.has(r.reason)) {
    await setSkip({ until: skipUntil(skipBackoffMs(r.reason, 0)), attempts: 0 });
  } else {
    await db.prepare("DELETE FROM meta WHERE key = ?").bind(skipKey).run();
  }
  return r;
}
