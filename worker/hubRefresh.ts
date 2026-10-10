import { haversine, tileRect } from "../shared/geo";
import type { Hub } from "../shared/hubs";
import { hubTiles } from "./hubTiles";
import { hubRefreshStart } from "./refreshSchedule";
import { TILES_CHANGED_KEY } from "./repo";
import { markHubsDirtyStmt } from "./snapshotDirty";

/**
 * R63 거점 갱신 완료 기록: meta `hub_refreshed:{hub}` = {start, at} — start는 다 끝낸 갱신의 시작(그 요일 00:00 KST),
 * at은 끝낸 시각. 갱신 중(새 시작 뒤 아직 못 끝냄)에는 지난번 기록이 그대로 남아 화면은 지난 완료 날짜를 계속 보여준다.
 */
export const HUB_REFRESHED_PREFIX = "hub_refreshed:";
export type HubRefreshed = { start: number; at: number };

export function parseHubRefreshed(raw: string | null | undefined): HubRefreshed | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<HubRefreshed>;
    return typeof o.start === "number" && typeof o.at === "number" ? { start: o.start, at: o.at } : null;
  } catch {
    return null;
  }
}

/** 한 거점의 완료 기록 (목록 응답·스냅샷 — meta 1행) */
export async function readHubRefreshed(db: D1Database, hubId: string): Promise<HubRefreshed | null> {
  const r = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(HUB_REFRESHED_PREFIX + hubId).first<{ value: string }>();
  return parseHubRefreshed(r?.value);
}

/** 읽어 둔 meta에서 tiles_changed_at(만료·미수집 커서)과 거점들의 완료 기록 (readCronMeta와 같은 해석) */
export function cronMetaFrom(
  meta: ReadonlyMap<string, string>, hubIds: readonly string[],
): { changedAt: number; refreshed: Map<string, HubRefreshed> } {
  const v = Number(meta.get(TILES_CHANGED_KEY) ?? 0);
  const refreshed = new Map<string, HubRefreshed>();
  for (const id of hubIds) {
    const r = parseHubRefreshed(meta.get(HUB_REFRESHED_PREFIX + id));
    if (r) refreshed.set(id, r);
  }
  return { changedAt: Number.isFinite(v) ? v : 0, refreshed };
}

/**
 * 본 Cron이 실행마다 한 번 읽는 meta: tiles_changed_at(만료·미수집 커서)과 거점들의 완료 기록을 한 질의로
 * (Task 34 D1 호출 예산 — 예전 tilesChangedAt 한 번과 같은 호출 수). extraKeys: 같은 질의로 더 읽을 키 (Task 57 — 쿨다운·커서·집계,
 * 돌려주는 meta에 읽은 키가 다 있다)
 */
export async function readCronMeta(
  db: D1Database, hubIds: readonly string[], extraKeys: readonly string[] = [],
): Promise<{ changedAt: number; refreshed: Map<string, HubRefreshed>; meta: Map<string, string> }> {
  const r = await db
    .prepare("SELECT key, value FROM meta WHERE key IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([TILES_CHANGED_KEY, ...hubIds.map((id) => HUB_REFRESHED_PREFIX + id), ...extraKeys]))
    .all<{ key: string; value: string }>();
  const meta = new Map(r.results.map((x) => [x.key, x.value] as const));
  return { ...cronMetaFrom(meta, hubIds), meta };
}

/**
 * 거점 격자(?1, 먼 칸부터)에 갱신할 가게가 하나라도 있나: 미수집(places 행 없음) 또는 ok인데 due_after(R66 — 없으면 fetched_at)가
 * ?2(그 거점의 갱신 시작) 전 — 긴 주기라 이번 주는 건너뛰는 가게는 완료를 막지 않는다.
 * 실패는 보지 않는다 (6시간마다 따로 다시 시도한다 — 계속 실패하는 가게가 완료를 영영 막지 않게).
 * CROSS JOIN으로 칸 순서를 먼 칸부터로 고정한다. Cron은 대체로 가까운 칸부터 갱신해서(만료 커서 쪽 안에서 시작·거리 순) 남은 대상이
 * 먼 칸에 있으면 일찍 멈춘다 — 보장은 아니다: 남은 대상이 가까운 칸 몇 곳뿐이면 거점 가게를 거의 다 읽고(~2~5k행),
 * 대상이 없을 때(완료 — 거점마다 주 1번)도 다 읽는다. 그래서 이번 보충 후보에 그 거점이 있으면 아예 묻지 않는다(maintenance.ts).
 */
export const HUB_DUE_EXISTS_SQL = `SELECT EXISTS (
  SELECT 1 FROM json_each(?1) AS k CROSS JOIN tile_places tp ON tp.tile_key = k.value
    LEFT JOIN places p ON p.id = tp.place_id
  WHERE p.id IS NULL OR (p.status = 'ok' AND COALESCE(p.due_after, p.fetched_at) < ?2)
) AS due`;

/** 거점 격자, 칸 중심이 거점에서 먼 순 (같으면 키순) */
function farthestFirst(hub: Hub): string[] {
  const d = (k: string) => {
    const r = tileRect(k);
    return haversine(hub, { lat: (r.minLat + r.maxLat) / 2, lng: (r.minLng + r.maxLng) / 2 });
  };
  return hubTiles(hub)
    .map((k) => [k, d(k)] as const)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k]) => k);
}

export async function hubHasDue(db: D1Database, hub: Hub, now: number): Promise<boolean> {
  const r = await db
    .prepare(HUB_DUE_EXISTS_SQL)
    .bind(JSON.stringify(farthestFirst(hub)), hubRefreshStart(hub, now))
    .first<{ due: number }>();
  return Number(r?.due ?? 0) === 1;
}

/** 완료 기록 + 그 거점 스냅샷 더러움 표시 (R56 — 목록 본문의 refreshedAt이 바뀐다), batch 하나 */
export async function recordHubRefreshed(db: D1Database, hubId: string, start: number, now: number): Promise<void> {
  const value: HubRefreshed = { start, at: now };
  await db.batch([
    db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(HUB_REFRESHED_PREFIX + hubId, JSON.stringify(value)),
    markHubsDirtyStmt(db, [hubId], now),
  ]);
}
