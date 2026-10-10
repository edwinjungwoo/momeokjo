import { DETAIL_FAIL_TTL_MS, DETAIL_OK_TTL_MS, TILE_TTL_MS } from "../shared/constants";
import { HUBS, type Hub } from "../shared/hubs";
import { refreshStart } from "../shared/refresh";
import { hubTiles, hubsOfTile } from "./hubTiles";

/**
 * R63 거점별 주 1회 갱신 (shared/hubs.ts `refreshDay`, shared/refresh.ts `refreshStart`).
 * 거점의 "갱신 시작" = 지금 이하인 가장 최근의 그 요일 00:00 KST.
 * - 상세: 거점 격자에 기록된 가게 중 ok인데 due_after(R66 — fetched_at + (간격 − 1) × 7일, 간격은 주기 안의 id 위상)가 시작 전인 것이 갱신 대상이다
 *   (실패는 그대로 6시간 뒤 다시).
 * - 격자: 거점 격자는 시작 전에 수집했으면 다시 수집한다 (7일 TTL 대신 — 시작은 언제나 7일 안이라 더 늦지 않다).
 * - 여러 거점이 덮는 격자(그 격자의 가게)는 어느 한 거점에게라도 대상이면 대상이다 = 가장 늦은 시작이 기준이다.
 * - 거점 격자가 아니면(관리자 warm의 임의 좌표) 예전 규칙: 상세 3일 + id별 지터, 격자 7일.
 */
export const hubRefreshStart = (hub: Pick<Hub, "refreshDay">, now: number): number => refreshStart(hub.refreshDay, now);

let memo: { now: number; byHub: Map<string, number> } | null = null;
/** 모든 거점의 이번 시작 (같은 now면 다시 계산하지 않는다 — 행마다 부른다) */
function startsAt(now: number): Map<string, number> {
  if (memo?.now !== now) memo = { now, byHub: new Map(HUBS.map((h) => [h.id, hubRefreshStart(h, now)])) };
  return memo.byHub;
}

/**
 * 이 격자를 PREWARM_RADIUS로 덮는 거점들의 이번 시작 (오름차순, 거점 격자가 아니면 빈 배열).
 * hubs를 넘기면 그 거점들로 계산한다 (테스트 — 겹치는 거점)
 */
export function tileRefreshStarts(key: string, now: number, hubs?: readonly Hub[]): number[] {
  if (hubs) {
    return hubs.filter((h) => hubTiles(h).includes(key)).map((h) => hubRefreshStart(h, now)).sort((a, b) => a - b);
  }
  const ids = hubsOfTile(key);
  if (ids.length === 0) return [];
  const s = startsAt(now);
  return ids.map((id) => s.get(id) as number).sort((a, b) => a - b);
}

/** 격자의 갱신 기준 시각 = 덮는 거점들의 가장 늦은 시작 (거점 격자가 아니면 null) */
export function tileRefreshStart(key: string, now: number, hubs?: readonly Hub[]): number | null {
  const s = tileRefreshStarts(key, now, hubs);
  return s.length === 0 ? null : s[s.length - 1];
}

/** R63/R3: 이 시각 이후에 수집했으면 다시 수집하지 않는다 — 거점 격자는 갱신 기준 시각, 밖은 now − 7일 + 1 */
export function tileFreshFrom(key: string, now: number): number {
  return tileRefreshStart(key, now) ?? now - TILE_TTL_MS + 1;
}

/**
 * ok 상세가 갱신 대상일 수 있는 상한(이 시각 전에 가져온 것만): 거점 격자는 갱신 기준 시각(정확),
 * 밖은 지터 전 기준 now − 3일 + 1 (실제 만료는 지터를 더해 다시 본다 — isPlaceDue)
 */
export function okDueBefore(key: string, now: number): number {
  return okDueBeforeOf(tileRefreshStart(key, now), now);
}

/** okDueBefore를 이미 구한 칸의 갱신 기준 시각(tileRefreshStart — 거점 격자가 아니면 null)으로 (같은 칸을 두 번 계산하지 않게) */
export const okDueBeforeOf = (start: number | null, now: number): number => start ?? now - DETAIL_OK_TTL_MS + 1;

/** 넘겨받은 거점들로 격자 → 그 격자를 덮는 거점들의 이번 시작(오름차순) (Cron 순서 — 전역 HUBS를 보지 않는다) */
export function refreshStartsIndex(hubs: readonly Hub[], now: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const h of hubs) {
    const start = hubRefreshStart(h, now);
    for (const k of hubTiles(h)) out.set(k, [...(out.get(k) ?? []), start]);
  }
  for (const v of out.values()) v.sort((a, b) => a - b);
  return out;
}

/**
 * 갱신 대상이 된 시각 (Cron 순서: 오래 기다린 것부터). starts: 그 칸을 덮는 거점들의 이번 시작(오름차순, 거점 밖이면 빈 배열).
 * ok는 due_after(R66 — 없으면 fetchedAt) 뒤의 가장 이른 시작(거점 격자) 또는 fetchedAt + 3일 + 지터(밖),
 * 실패는 fetchedAt + 6시간. 대상인 것에만 부른다
 */
export function dueSinceOf(
  meta: { status: "ok" | "failed"; fetchedAt: number; dueAfter?: number | null }, starts: readonly number[], jitterMs: number,
): number {
  if (meta.status !== "ok") return meta.fetchedAt + DETAIL_FAIL_TTL_MS;
  if (starts.length === 0) return meta.fetchedAt + DETAIL_OK_TTL_MS + jitterMs;
  const due = meta.dueAfter ?? meta.fetchedAt;
  return starts.find((s) => due < s) ?? starts[starts.length - 1];
}
