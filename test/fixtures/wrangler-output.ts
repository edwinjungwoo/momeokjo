// scripts/release.mjs 테스트용 wrangler 출력 (wrangler 4.147 형식: 2026-10-06 운영 배포와 wrangler-dist/cli.js의 출력 코드 기준).
// 계정 메일·비밀값은 넣지 않는다.

/** `wrangler d1 migrations list momeokjo --remote` — 적용할 것이 있을 때 (logger.table = cli-table3 상자 표) */
export const MIGRATIONS_PENDING = [
  "",
  " ⛅️ wrangler 4.147.0",
  "───────────────────",
  "Resource location: remote",
  "",
  "Migrations to be applied:",
  "┌────────────────────┐",
  "│ Name               │",
  "├────────────────────┤",
  "│ 0003_meta.sql      │",
  "├────────────────────┤",
  "│ 0004_events.sql    │",
  "├────────────────────┤",
  "│ 0005_list_json.sql │",
  "└────────────────────┘",
  "",
].join("\n");

/** 0005 하나만 남았을 때 (색이 켜진 터미널처럼 ANSI·CRLF가 섞여도 읽어야 한다) */
export const MIGRATIONS_PENDING_0005_ANSI =
  " ⛅️ wrangler 4.147.0\r\n\u001b[90m───────────────────\u001b[39m\r\nResource location: remote\r\n\r\nMigrations to be applied:\r\n" +
  "\u001b[90m┌────────────────────┐\u001b[39m\r\n\u001b[90m│\u001b[39m\u001b[34m Name               \u001b[39m\u001b[90m│\u001b[39m\r\n" +
  "\u001b[90m├────────────────────┤\u001b[39m\r\n\u001b[90m│\u001b[39m 0005_list_json.sql \u001b[90m│\u001b[39m\r\n\u001b[90m└────────────────────┘\u001b[39m\r\n";

/** 적용할 것이 없을 때 */
export const MIGRATIONS_NONE = "\n ⛅️ wrangler 4.147.0\n───────────────────\nResource location: remote\n\n✅ No migrations to apply!\n";

/** `wrangler d1 execute momeokjo --remote --json --command "SELECT 1"` */
export const D1_SELECT_1 = JSON.stringify([{ results: [{ "1": 1 }], success: true, meta: { served_by: "v3-prod", duration: 0.2, rows_read: 0, rows_written: 0 } }], null, 2);

/** D1 일일 한도(무료 플랜)에 걸렸을 때 — --json이면 오류도 JSON으로 나온다 */
export const D1_LIMIT_ERROR = JSON.stringify(
  { error: { text: "A request to the Cloudflare API (/accounts/xxx/d1/database/xxx/query) failed.", notes: [{ text: "Exceeded maximum DB read rows limit for the day. Please try again later. [code: 7500]" }] } },
  null,
  2,
);

export const d1Rows = (rows: Record<string, unknown>[]) => JSON.stringify([{ results: rows, success: true, meta: { rows_read: rows.length } }], null, 2);

/** `wrangler secret list --format json` (이름과 종류만 나온다) */
export const SECRETS_JSON = JSON.stringify([
  { name: "ADMIN_TOKEN", type: "secret_text" },
  { name: "KAKAO_REST_KEY", type: "secret_text" },
]);

/** `npm run deploy` (vite build && wrangler deploy)의 끝부분 */
export const DEPLOY_OUTPUT = [
  "> momeokjo@ deploy",
  "> vite build && wrangler deploy",
  "",
  "✓ built in 512ms",
  "",
  " ⛅️ wrangler 4.147.0",
  "───────────────────",
  "Total Upload: 412.10 KiB / gzip: 98.20 KiB",
  "Worker Startup Time: 14 ms",
  "Your Worker has access to the following bindings:",
  "Binding                                   Resource",
  "env.DB (momeokjo)                         D1 Database",
  "env.RATE_LIMITER (1001)                   Rate Limit",
  "env.ADMIN_LIMITER (1002)                  Rate Limit",
  'env.SUBREQUEST_BUDGET ("40")              Environment Variable',
  "",
  "Uploaded momeokjo (6.21 sec)",
  "Deployed momeokjo triggers (1.94 sec)",
  "  mmj.itmz.me (custom domain)",
  "  schedule: */5 * * * *",
  "Current Version ID: 72a9f970-5b1e-4c7d-9a3f-1e2d3c4b5a69",
  "",
].join("\n");

export const PREV_VERSION = "2f5adde0-8c4b-4f1a-b2d3-6e7f8a9b0c1d";
export const NEW_VERSION = "72a9f970-5b1e-4c7d-9a3f-1e2d3c4b5a69";

/** `wrangler deployments list --json` — created_on 오름차순 (마지막이 지금 활성) */
export const deploymentsJson = (activeId: string) =>
  JSON.stringify(
    [
      {
        id: "d0000000-0000-4000-8000-000000000001",
        source: "wrangler",
        strategy: "percentage",
        author_email: "operator@example.com",
        created_on: "2026-10-05T05:10:00.000000Z",
        annotations: { "workers/triggered_by": "upload" },
        versions: [{ version_id: "0a1b2c3d-0000-4000-8000-000000000000", percentage: 100 }],
      },
      {
        id: "d0000000-0000-4000-8000-000000000002",
        source: "wrangler",
        strategy: "percentage",
        author_email: "operator@example.com",
        created_on: "2026-10-06T00:24:00.000000Z",
        annotations: { "workers/triggered_by": "rollback" },
        versions: [{ version_id: activeId, percentage: 100 }],
      },
    ],
    null,
    2,
  );

/** `wrangler deployments list` (JSON이 아닌 기본 출력) */
export const DEPLOYMENTS_PRETTY = [
  "Created:     2026-10-05T05:10:00.000Z",
  "Author:      operator@example.com",
  "Source:      Upload",
  "Message:     -",
  "Version(s):  (100%) 0a1b2c3d-0000-4000-8000-000000000000",
  "                 Created:  2026-10-05T05:09:58.000Z",
  "                     Tag:  -",
  "                 Message:  -",
  "",
  "Created:     2026-10-06T00:24:00.000Z",
  "Author:      operator@example.com",
  "Source:      Rollback",
  "Message:     -",
  `Version(s):  (100%) ${PREV_VERSION}`,
  "                 Created:  2026-10-05T14:02:11.000Z",
  "                     Tag:  -",
  "                 Message:  -",
  "",
].join("\n");

/** scripts/smoke.sh 출력 (smoke.sh의 bad()는 "  FAIL  <설명>" 줄을 찍는다). fails는 FAIL 줄 내용 또는 개수 */
export const smokeOutput = (fails: number | string[] = [], warns = 1) => {
  const lines = typeof fails === "number" ? Array.from({ length: fails }, (_, i) => `/robots.txt → 50${i} 또는 Disallow 줄이 없음`) : fails;
  return [
    "모먹죠 스모크 → https://mmj.itmz.me",
    "== 정적 파일",
    "  ok    / 200, 제목 '모먹죠 - 점심 고?'",
    ...lines.map((l) => `  FAIL  ${l}`),
    "",
    `요청 25번 · FAIL ${lines.length} · WARN ${warns}`,
    "",
  ].join("\n");
};

/** 실제 smoke.sh의 FAIL 줄 모양들 (자산 이름의 해시는 빌드마다 바뀐다) */
export const FAIL_ASSET_OLD = "/assets/index-CePFwRKS.js → 404, cache-control '' (immutable 1년 기대, public/_headers 확인)";
export const FAIL_ASSET_NEW = "/assets/index-Zb9xQ2aa.js → 404, cache-control '' (immutable 1년 기대, public/_headers 확인)";
export const FAIL_PLACES_500 = "ddp 500m → 500";
export const FAIL_PLACES_000 = "ddp 500m → 000";
export const FAIL_AUDIT = '감사 ddp → 200 {"pass":{"q1":false,"q2":true}}';
export const FAIL_EMPTY = "pangyo 500m 200인데 0곳";
