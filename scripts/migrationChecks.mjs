// npm run release(scripts/deploy.mjs)가 마이그레이션마다 하는 확인과 후속 작업 (Task 32).
// 새 마이그레이션을 더하면 여기에 한 항목을 더한다 — 없어도 배포는 되지만 "적용 뒤 남은 것 없음"만 확인한다.
//   checks: 운영 D1에 보낼 읽기 쿼리와 결과의 name 열에 있어야 하는 이름들.
//           적용 전에는 하나도 없어야 하고(있으면 일부만 적용된 상태 → 손으로 맞춘다), 적용 뒤에는 모두 있어야 한다.
//   hooks:  그 마이그레이션을 이번에 적용했을 때만 배포 뒤 돌리는 명령 (거점 id 목록을 받아 명령 목록을 만든다)
// node와 테스트(workerd) 둘 다에서 돌도록 의존성 없음

/** 0005 백필 한 번에 채우는 행 수 — 배포 직후 캐시가 비어 CPU가 빠듯할 때를 위해 서버 최대(300)의 절반 */
export const BACKFILL_HOOK_LIMIT = 150;

export const MIGRATION_CHECKS = {
  "0003_meta.sql": {
    checks: [
      {
        what: "meta 테이블·idx_places_status_fetched_at 인덱스",
        sql: "SELECT name FROM sqlite_master WHERE name IN ('meta', 'idx_places_status_fetched_at')",
        expect: ["meta", "idx_places_status_fetched_at"],
      },
    ],
  },
  "0004_events.sql": {
    checks: [
      {
        what: "events 테이블·idx_events_day·idx_events_type_day 인덱스",
        sql: "SELECT name FROM sqlite_master WHERE name IN ('events', 'idx_events_day', 'idx_events_type_day')",
        expect: ["events", "idx_events_day", "idx_events_type_day"],
      },
    ],
  },
  "0005_list_json.sql": {
    checks: [{ what: "places.list_json 열", sql: "PRAGMA table_info(places)", expect: ["list_json"] }],
    hooks: [
      {
        name: `list_json 백필 (거점별, --limit ${BACKFILL_HOOK_LIMIT})`,
        needsAdminToken: true,
        commands: (hubIds) =>
          hubIds.map((id) => ({ cmd: "node", args: ["scripts/backfill.mjs", "--hub", id, "--limit", String(BACKFILL_HOOK_LIMIT)] })),
      },
    ],
  },
  // R59: 관리자 대시보드 일별 집계 표. 후속 작업 없음 — 본 Cron이 밀린 날을 오래된 날부터 채운다 (실행마다 3일, UTC 하루 7일까지)
  "0006_daily_rollups.sql": {
    checks: [
      {
        what: "daily_stats·anon_first_seen 테이블",
        sql: "SELECT name FROM sqlite_master WHERE name IN ('daily_stats', 'anon_first_seen')",
        expect: ["daily_stats", "anon_first_seen"],
      },
    ],
  },
  // R56: 스냅샷 표. 후속 작업 없음 — 스냅샷 Cron(둘째 트리거의 7·17·…분, R63 전에는 2-59/5)이 거점마다 채우고, 그동안은 실시간 경로로 답한다
  "0007_hub_snapshots.sql": {
    checks: [
      {
        what: "hub_snapshots 테이블",
        sql: "SELECT name FROM sqlite_master WHERE name IN ('hub_snapshots')",
        expect: ["hub_snapshots"],
      },
    ],
  },
};

/**
 * 쿼리 결과(name 열)에 기대한 이름이 모두 있는지
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} expect
 * @returns {"all" | "partial" | "none"}
 */
export function objectState(rows, expect) {
  const names = new Set(rows.map((r) => r.name));
  const found = expect.filter((n) => names.has(n)).length;
  return found === expect.length ? "all" : found === 0 ? "none" : "partial";
}
