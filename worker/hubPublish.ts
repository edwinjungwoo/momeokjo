import { isCandidateHubId, isPublicHubId, type Hub } from "../shared/hubs";
import { auditDetail, auditHasMissing, auditPassOf, auditTiles } from "./audit";
import { farthestFirst } from "./hubRefresh";
import { hubTiles } from "./hubTiles";
import {
  HUB_PUBLIC_CHECK_PREFIX, HUB_PUBLIC_PREFIX, parsePublishCheck, parsePublishRecord, publishCheckStmt, writePublishRecord,
  type AuditSummary, type PublishCheck,
} from "./publicHubs";

/** R68: 한 후보를 다시 확인하기까지 (공개는 서두를 일이 아니라 시간당 한 번이면 된다) */
export const PUBLISH_CHECK_INTERVAL_MS = 60 * 60_000;
/**
 * R68: 상세 커버리지(Q2)에서 막힌 뒤에는 6시간 — 실패한 상세는 6시간마다 다시 시도해서(R9) 그 전에는 결과가 거의 같고,
 * 다 채운 거점의 커버리지 확인은 거점 가게를 두 번(미수집 확인 + 집계) 읽는다 (~수천 행)
 */
export const PUBLISH_COVERAGE_RETRY_MS = 6 * 60 * 60_000;
/** R68: 공개 확인 한 번의 최악 D1 호출 — 격자 집계 1 + 미수집 확인 1 + 상세 집계 1 + 기록 batch 1 */
export const PUBLISH_CHECK_D1_CALLS = 4;

const nextCheckAt = (c: PublishCheck) => c.at + (c.reason === "coverage" ? PUBLISH_COVERAGE_RETRY_MS : PUBLISH_CHECK_INTERVAL_MS);

/**
 * R68: 이번 본 Cron이 공개를 확인할 후보 하나 (없으면 null). 공개 후보(ready: false)이고, 공개·숨김 기록이 없고(관리자가 공개를 취소한
 * 후보는 다시 자동 공개하지 않는다), 다시 볼 때가 된 것 중 마지막 확인이 가장 오래된 것(처음이면 먼저, 같으면 id순).
 * meta는 본 Cron이 이미 읽은 값(candidateMetaKeys 포함) — D1 호출이 없다
 */
export function pickPublishCheck(hubs: readonly Hub[], meta: ReadonlyMap<string, string>, now: number): Hub | null {
  let best: { hub: Hub; at: number } | null = null;
  for (const hub of hubs) {
    if (hub.ready || !isCandidateHubId(hub.id)) continue;
    if (parsePublishRecord(meta.get(HUB_PUBLIC_PREFIX + hub.id))) continue;
    const last = parsePublishCheck(meta.get(HUB_PUBLIC_CHECK_PREFIX + hub.id));
    if (last && nextCheckAt(last) > now) continue;
    const at = last?.at ?? Number.NEGATIVE_INFINITY;
    if (!best || at < best.at || (at === best.at && hub.id < best.hub.id)) best = { hub, at };
  }
  return best?.hub ?? null;
}

/**
 * R68: 후보 하나의 공개 확인 — 싼 것부터 막히는 곳에서 멈춘다: ① 격자를 다 모았고 포화 없음(Q1, 격자 행만) ② 상세 미수집 0(먼 칸부터,
 * 채우는 중이면 일찍 멈춤) ③ 상세 커버리지 95 % 이상(Q2, 집계 한 행). 모두 auditArea(관리자 감사·스모크)와 같은 정의다(worker/audit.ts).
 * 질의는 D1 안에서 집계해 Worker는 결과 몇 행만 받는다 — 장소 본문을 읽지 않아 CPU가 거의 들지 않으므로 격자 수집·보충을 한 실행에서도 돈다.
 * 결과는 meta hub_public_check:{id}에, 통과하면 같은 batch로 공개 기록 hub_public:{id}(by auto, 감사 숫자)을 쓰고 이 격리 공간에 바로 알린다.
 * D1 호출은 많아야 PUBLISH_CHECK_D1_CALLS
 */
export async function runPublishCheck(db: D1Database, hub: Hub, now: number): Promise<PublishCheck> {
  const keys = hubTiles(hub);
  const tiles = await auditTiles(db, keys);
  const tileAudit = { tiles: tiles.total, collected: tiles.collected, saturated: tiles.saturated };
  let result: PublishCheck;
  if (tiles.collected < tiles.total) result = { at: now, pass: false, reason: "tiles", audit: tileAudit };
  else if (tiles.saturated > 0) result = { at: now, pass: false, reason: "saturated", audit: tileAudit };
  else if (await auditHasMissing(db, farthestFirst(hub))) result = { at: now, pass: false, reason: "missing", audit: tileAudit };
  else {
    const { places, detail } = await auditDetail(db, keys);
    const audit: AuditSummary = { places, ...detail, ...tileAudit };
    const pass = detail.missing === 0 && auditPassOf(tiles, detail.coverage).q2;
    result = { at: now, pass, reason: pass ? null : detail.missing > 0 ? "missing" : "coverage", audit };
  }
  if (!result.pass) {
    await publishCheckStmt(db, hub.id, result).run();
    return result;
  }
  await writePublishRecord(db, hub.id, { state: "public", at: now, by: "auto", audit: result.audit as AuditSummary }, now, [
    publishCheckStmt(db, hub.id, result),
  ]);
  // 그사이 관리자가 공개를 취소했으면(숨김 기록) 자동 공개는 아무것도 쓰지 않았다 (writePublishRecord)
  if (isPublicHubId(hub.id)) console.log(`hub published ${hub.id}`);
  return result;
}
