import { PREWARM_RADIUS } from "../shared/constants";
import { boundingBox } from "../shared/geo";
import { HUBS } from "../shared/hubs";
import type { LatLng } from "../shared/types";

/**
 * R56 거점 스냅샷의 "더러움" 표시와 무효화 (worker/hubSnapshot.ts가 읽는다).
 * 거점마다 meta `snapshot_dirty:{hub}` = 마지막으로 그 거점 목록이 바뀐 표시(정수, 바뀔 때마다 커진다).
 * 스냅샷은 만들기 전에 읽은 표시를 source_at에 두고, 지금 표시와 다르면 더럽다(다시 만들 대상).
 * 쓰는 쪽(상세 저장, 격자 ID 변경, 쿨다운)은 같은 batch에 이 문장을 넣는다 — 별도 왕복이 없다.
 */
export const SNAPSHOT_DIRTY_PREFIX = "snapshot_dirty:";

/** 표시를 올린다: 지금 시각 또는 이전 값 + 1 중 큰 값 (같은 ms에 두 번 바뀌어도 값이 달라진다) */
const BUMP = `ON CONFLICT(key) DO UPDATE SET value = MAX(CAST(meta.value AS INTEGER) + 1, CAST(excluded.value AS INTEGER))`;

/** 주어진 거점들의 표시를 올리는 한 문장 */
export function markHubsDirtyStmt(db: D1Database, hubIds: readonly string[], now: number): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO meta (key, value) SELECT '${SNAPSHOT_DIRTY_PREFIX}' || value, ? FROM json_each(?) WHERE true ${BUMP}`)
    .bind(String(now), JSON.stringify(hubIds));
}

/** 거점마다 1000m 상자 [id, minLat, maxLat, minLng, maxLng] — 목록에 들어갈 수 있는 가게(거리 ≤ 1000m)는 모두 이 안에 있다 */
const HUB_BOXES = JSON.stringify(
  HUBS.map((h) => {
    const b = boundingBox(h, PREWARM_RADIUS);
    return [h.id, b.minLat, b.maxLat, b.minLng, b.maxLng];
  }),
);
const inBox = (p: LatLng, h: (typeof HUBS)[number]) => {
  const b = boundingBox(h, PREWARM_RADIUS);
  return p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng;
};

/**
 * 가게 한 곳의 저장이 바꿀 수 있는 거점들의 표시를 올리는 한 문장:
 * 지금 저장된 좌표(옮기기 전, SQL에서 PK로 읽음)나 새 좌표(next)가 거점의 1000m 상자 안인 거점.
 * 상세 저장은 이 문장을 INSERT보다 먼저 둬서 옮기기 전 좌표를 본다. 어느 거점과도 멀면 아무것도 쓰지 않는다.
 */
export function markPlaceHubsDirtyStmt(db: D1Database, id: string, next: LatLng | null, now: number): D1PreparedStatement {
  const nextHubs = next ? HUBS.filter((h) => inBox(next, h)).map((h) => h.id) : [];
  return db
    .prepare(
      `INSERT INTO meta (key, value)
       SELECT '${SNAPSHOT_DIRTY_PREFIX}' || json_extract(h.value, '$[0]'), ?1 FROM json_each(?2) AS h
       WHERE json_extract(h.value, '$[0]') IN (SELECT value FROM json_each(?3))
          OR EXISTS (SELECT 1 FROM places p WHERE p.id = ?4
               AND p.lat BETWEEN json_extract(h.value, '$[1]') AND json_extract(h.value, '$[2]')
               AND p.lng BETWEEN json_extract(h.value, '$[3]') AND json_extract(h.value, '$[4]'))
       ${BUMP}`,
    )
    .bind(String(now), HUB_BOXES, JSON.stringify(nextHubs), id);
}

/**
 * markPlaceHubsDirtyStmt를 여러 곳에 한 번에 (Task 34 — 한 번의 보충을 batch 하나로 저장할 때):
 * 어느 한 곳이라도 저장된 좌표(옮기기 전)나 새 좌표(next)가 1000m 상자 안인 거점의 표시를 거점마다 한 번 올린다.
 * 저장 문장들보다 먼저 둔다. 어느 거점과도 멀면 아무것도 쓰지 않는다.
 */
export function markPlacesHubsDirtyStmt(
  db: D1Database, places: readonly { id: string; next: LatLng | null }[], now: number,
): D1PreparedStatement {
  const nextHubs = HUBS.filter((h) => places.some((p) => p.next !== null && inBox(p.next, h))).map((h) => h.id);
  return db
    .prepare(
      `INSERT INTO meta (key, value)
       SELECT '${SNAPSHOT_DIRTY_PREFIX}' || json_extract(h.value, '$[0]'), ?1 FROM json_each(?2) AS h
       WHERE json_extract(h.value, '$[0]') IN (SELECT value FROM json_each(?3))
          OR EXISTS (SELECT 1 FROM places p WHERE p.id IN (SELECT value FROM json_each(?4))
               AND p.lat BETWEEN json_extract(h.value, '$[1]') AND json_extract(h.value, '$[2]')
               AND p.lng BETWEEN json_extract(h.value, '$[3]') AND json_extract(h.value, '$[4]'))
       ${BUMP}`,
    )
    .bind(String(now), HUB_BOXES, JSON.stringify(nextHubs), JSON.stringify(places.map((p) => p.id)));
}

/** 거점 스냅샷을 지운다 (pending이 새로 생김·상세 쿨다운처럼 스냅샷이 틀린 값을 말하게 되는 변화). hubIds가 없으면 모두 */
export function deleteSnapshotsStmt(db: D1Database, hubIds?: readonly string[]): D1PreparedStatement {
  return hubIds
    ? db.prepare("DELETE FROM hub_snapshots WHERE hub IN (SELECT value FROM json_each(?))").bind(JSON.stringify(hubIds))
    : db.prepare("DELETE FROM hub_snapshots");
}
