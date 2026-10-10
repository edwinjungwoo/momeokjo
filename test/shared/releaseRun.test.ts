// scripts/release.mjs runRelease를 가짜 실행기로 돌린다 — wrangler·npm·git·curl을 실제로 부르지 않는다
import { describe, expect, it } from "vitest";
import { runRelease, smokeAuditPick, type ReleaseOpts, type RunResult } from "../../scripts/release.mjs";
import sql0003 from "../../migrations/0003_meta.sql?raw";
import sql0005 from "../../migrations/0005_list_json.sql?raw";
import SMOKE_ALL_DOWN from "../fixtures/smoke-all-down.txt?raw";
import {
  D1_LIMIT_ERROR,
  D1_SELECT_1,
  d1Rows,
  DEPLOY_OUTPUT,
  deploymentsJson,
  FAIL_ASSET_NEW,
  FAIL_ASSET_OLD,
  emptyFail,
  FAIL_AUDIT,
  FAIL_AUDIT_500,
  FAIL_EMPTY,
  FAIL_PLACES_000,
  FAIL_PLACES_500,
  MIGRATIONS_NONE,
  MIGRATIONS_PENDING_0005_ANSI,
  NEW_VERSION,
  PREV_VERSION,
  SECRETS_JSON,
  smokeOutput,
} from "../fixtures/wrangler-output";

const SHA = "fc22b79d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f7";
const TOKEN = "secret-admin-token-value";
const HUBS = ["bongeunsa", "ddp", "pangyo", "naebang", "gwacheon"];
const LIST_JSON_CHECK = "npx wrangler d1 execute momeokjo --remote --json --command PRAGMA table_info(places)";
const PLACES_COLUMNS = [{ name: "id" }, { name: "name" }, { name: "status" }];
const PLACES_COLUMNS_0005 = [...PLACES_COLUMNS, { name: "list_json" }];

type Reply = RunResult | ((call: Call) => RunResult);
type Call = { line: string; env: Record<string, string> };
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "", code = 1, stdout = ""): RunResult => ({ code, stdout, stderr });

/** 0005가 남은 운영(지금 2f5adde0)에 배포가 잘 되는 기본 응답. 배열은 차례로 하나씩 쓴다 */
function happyReplies(): Record<string, Reply | Reply[]> {
  return {
    "git rev-parse --abbrev-ref HEAD": ok("feat/mvp\n"),
    "git status --porcelain": ok(""),
    "git fetch --quiet origin feat/mvp": ok(),
    "git rev-parse HEAD": ok(SHA + "\n"),
    "git rev-parse origin/feat/mvp": ok(SHA + "\n"),
    "bash -c": ok(),
    "npm run typecheck": ok(),
    "npm test": ok(),
    "npm run build": ok(),
    "npx wrangler secret list --format json": ok(SECRETS_JSON),
    "npx wrangler d1 execute momeokjo --remote --json --command SELECT 1": ok(D1_SELECT_1),
    "npx wrangler d1 migrations list momeokjo --remote": [ok(MIGRATIONS_PENDING_0005_ANSI), ok(MIGRATIONS_NONE)],
    [LIST_JSON_CHECK]: [ok(d1Rows(PLACES_COLUMNS)), ok(d1Rows(PLACES_COLUMNS_0005))],
    "npx wrangler d1 migrations apply momeokjo --remote": ok("✅ 0005_list_json.sql\n"),
    "npx wrangler deployments list --json": ok(deploymentsJson(PREV_VERSION)),
    "npm run deploy": ok(DEPLOY_OUTPUT),
    "node scripts/backfill.mjs": ok("완료 — 채운 행 10\n"),
    "bash scripts/smoke.sh": ok(smokeOutput(0)),
    "npx wrangler rollback": ok(`Current Version ID: ${PREV_VERSION}\n`),
    // 롤백 대상 커밋의 설정 — 기본은 이번 배포와 같은 crons
    "git show": ok(cronsConfig(CURRENT_CRONS)),
  };
}

function harness(
  over: Record<string, Reply | Reply[]> = {},
  extra: { files?: Record<string, string>; isTTY?: boolean; confirm?: boolean; adminToken?: string | null; hubIds?: string[]; publicHubIds?: string[] } = {},
) {
  const replies = { ...happyReplies(), ...over };
  const used: Record<string, number> = {};
  const calls: Call[] = [];
  const logs: string[] = [];
  const appended: { path: string; text: string }[] = [];
  const written: { path: string; text: string }[] = [];
  const sleeps: number[] = [];
  const files: Record<string, string> = {
    "dist/client/index.html": '<script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=abc&autoload=false"></script>',
    "migrations/0003_meta.sql": sql0003,
    "migrations/0005_list_json.sql": sql0005,
    "docs/deploys.md": DEPLOY_LOG_WITH_PREV,
    "wrangler.jsonc": cronsConfig(CURRENT_CRONS),
    ...extra.files,
  };
  let clock = Date.UTC(2026, 9, 6, 0, 0);
  const deps = {
    async run(cmd: string, args: string[], o: { env?: Record<string, string>; echo?: boolean } = {}) {
      const line = [cmd, ...args].join(" ");
      const call = { line, env: o.env ?? {} };
      calls.push(call);
      const key = Object.keys(replies)
        .filter((k) => line === k || line.startsWith(k + " "))
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) throw new Error(`테스트에 없는 명령: ${line}`);
      const r = replies[key];
      let reply: Reply;
      if (Array.isArray(r)) {
        const i = used[key] ?? 0;
        used[key] = i + 1;
        reply = r[Math.min(i, r.length - 1)];
      } else reply = r;
      return typeof reply === "function" ? reply(call) : reply;
    },
    readFile: (p: string) => files[p],
    appendFile: (p: string, text: string) => void appended.push({ path: p, text }),
    writeFile: (p: string, text: string) => {
      files[p] = text;
      written.push({ path: p, text });
    },
    log: (s: string) => void logs.push(s),
    confirm: async () => extra.confirm ?? true,
    sleep: async (ms: number) => void sleeps.push(ms),
    now: () => (clock += 1000),
    isTTY: extra.isTTY ?? false,
    adminToken: extra.adminToken === null ? undefined : (extra.adminToken ?? TOKEN),
    hubIds: extra.hubIds ?? HUBS,
    publicHubIds: extra.publicHubIds ?? extra.hubIds ?? HUBS,
  };
  const ran = (prefix: string) => calls.filter((c) => c.line === prefix || c.line.startsWith(prefix + " "));
  return { deps, calls, logs, appended, written, files, sleeps, ran, output: () => logs.join("\n") };
}

/** 롤백 대상(PREV_VERSION)을 배포한 커밋 — docs/deploys.md 기록으로 찾는다 */
const PREV_COMMIT = "a1b2c3d";
const DEPLOY_LOG_EMPTY = "# 배포 기록\n\n| 날짜 (KST) | 버전 | 커밋 | 마이그레이션 | 결과 | 롤백 대상 |\n|---|---|---|---|---|---|\n";
const DEPLOY_LOG_WITH_PREV = `${DEPLOY_LOG_EMPTY}| 2026-10-05 20:00 | ${PREV_VERSION.slice(0, 8)} | ${PREV_COMMIT} | - | 성공 | 1234abcd |\n`;
const CURRENT_CRONS = ["*/5 * * * *", "* * * * *"];
const cronsConfig = (crons: string[]) =>
  `{\n  // 예전에는 "1-59/2 * * * *"였다\n  "triggers": { "crons": [${crons.map((c) => JSON.stringify(c)).join(", ")}] },\n}\n`;

const opts = (o: Partial<ReleaseOpts> = {}): ReleaseOpts => ({ dryRun: false, skipTests: false, force: false, yes: true, allowDestructive: false, acceptBaselineFails: false, ...o });

describe("infra: npm run release — 정상 흐름", () => {
  it("infra: 사전 확인 → D1 → 0005 적용·확인 → 롤백 대상 기록 → 배포 → 거점별 백필 → 스모크 순서, 종료 코드 0", async () => {
    const h = harness();
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(0);
    const order = h.calls.map((c) => c.line);
    const idx = (p: string) => order.findIndex((l) => l.startsWith(p));
    const steps = [
      "git rev-parse --abbrev-ref HEAD",
      "npm run typecheck",
      "npm test",
      "npm run build",
      "npx wrangler secret list",
      "npx wrangler d1 execute momeokjo --remote --json --command SELECT 1",
      "npx wrangler d1 migrations list",
      // 롤백 대상은 적용 전에 정한다 (트래픽이 나뉘었으면 스키마를 바꾸기 전에 멈추게)
      "npx wrangler deployments list --json",
      "npx wrangler d1 migrations apply momeokjo --remote",
      "bash scripts/smoke.sh", // 기준 스모크 (배포 전)
      "npm run deploy",
      "node scripts/backfill.mjs --hub bongeunsa --limit 150",
    ];
    for (let i = 1; i < steps.length; i++) expect(idx(steps[i - 1]), `${steps[i - 1]} → ${steps[i]}`).toBeLessThan(idx(steps[i]));
    // 배포 뒤 스모크는 후속 작업 다음
    expect(order.lastIndexOf("bash scripts/smoke.sh")).toBeGreaterThan(idx("node scripts/backfill.mjs --hub gwacheon"));
    expect(h.ran("bash scripts/smoke.sh")).toHaveLength(2);
    // 배포 직전에 트리·HEAD를 다시 본다 (확인 질문·기준 스모크 뒤)
    expect(h.ran("git status --porcelain")).toHaveLength(2);
    expect(order.lastIndexOf("git rev-parse HEAD")).toBeLessThan(idx("npm run deploy"));
    expect(order.lastIndexOf("git rev-parse HEAD")).toBeGreaterThan(idx("bash scripts/smoke.sh"));
    // 적용 전 확인(없어야 함)과 적용 뒤 확인(있어야 함)을 둘 다 한다
    expect(h.ran(LIST_JSON_CHECK)).toHaveLength(2);
    expect(h.ran("npx wrangler d1 migrations list")).toHaveLength(2);
    expect(h.ran("node scripts/backfill.mjs").map((c) => c.line)).toEqual(HUBS.map((id) => `node scripts/backfill.mjs --hub ${id} --limit 150`));
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
    expect(res.summary).toMatchObject({
      previousVersion: PREV_VERSION,
      newVersion: NEW_VERSION,
      migrationsApplied: ["0005_list_json.sql"],
      smoke: { fails: 0 },
      rolledBack: false,
    });
  });

  it("infra: 스모크·백필은 운영 주소와 관리자 토큰을 환경 변수로만 받고, 토큰은 어디에도 출력하지 않는다", async () => {
    const h = harness();
    await runRelease(opts(), h.deps);
    const smoke = h.ran("bash scripts/smoke.sh")[0];
    expect(smoke.env).toMatchObject({ B: "https://mmj.itmz.me", ADMIN_TOKEN: TOKEN });
    expect(h.ran("node scripts/backfill.mjs")[0].env).toMatchObject({ ADMIN_TOKEN: TOKEN, MMJ_BASE: "https://mmj.itmz.me" });
    expect(h.calls.every((c) => !c.line.includes(TOKEN))).toBe(true);
    expect(h.output()).not.toContain(TOKEN);
    expect(h.appended.map((a) => a.text).join("")).not.toContain(TOKEN);
  });

  it("infra: docs/deploys.md에 한 줄 더하고 커밋은 하지 않는다", async () => {
    const h = harness();
    await runRelease(opts(), h.deps);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0].path).toBe("docs/deploys.md");
    // 시각은 시작 시각(가짜 시계 09:00:01)
    expect(h.appended[0].text).toBe("| 2026-10-06 09:00 | 72a9f970 | fc22b79 | 0005_list_json | 성공 | 2f5adde0 |\n");
    expect(h.calls.some((c) => c.line.startsWith("git commit") || c.line.startsWith("git add") || c.line.startsWith("git push"))).toBe(false);
    expect(h.output()).toContain("git add docs/deploys.md");
  });

  it("infra: docs/deploys.md가 없으면 머리글과 함께 만든다", async () => {
    const h = harness({}, { files: { "docs/deploys.md": undefined as unknown as string } });
    await runRelease(opts(), h.deps);
    expect(h.appended[0].text).toMatch(/^# 배포 기록[\s\S]*\| 날짜 \(KST\) \|[\s\S]*\| 72a9f970 \|/);
  });

  it("infra: 적용할 마이그레이션이 없으면 적용·확인·후속 작업 없이 배포·스모크만", async () => {
    const h = harness({ "npx wrangler d1 migrations list momeokjo --remote": ok(MIGRATIONS_NONE) });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(0);
    expect(h.ran("npx wrangler d1 migrations apply")).toHaveLength(0);
    expect(h.ran(LIST_JSON_CHECK)).toHaveLength(0);
    expect(h.ran("node scripts/backfill.mjs")).toHaveLength(0);
    expect(h.ran("npm run deploy")).toHaveLength(1);
    expect(h.ran("bash scripts/smoke.sh")).toHaveLength(2); // 기준 + 배포 뒤
  });

  it("infra: 배포 출력에 버전이 없으면 deployments list로 새 활성 버전을 확인한다", async () => {
    const h = harness({
      "npm run deploy": ok("Uploaded momeokjo\n"),
      "npx wrangler deployments list --json": [ok(deploymentsJson(PREV_VERSION)), ok(deploymentsJson(NEW_VERSION))],
    });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(0);
    expect(res.summary.newVersion).toBe(NEW_VERSION);
  });

  it("infra: 백필이 D1 예산 소진(종료 코드 2)이면 경고만 하고 계속, 다른 실패면 끝에 확인 필요(3)", async () => {
    const budget = harness({ "node scripts/backfill.mjs": fail("HTTP 429 read_budget", 2) });
    expect((await runRelease(opts(), budget.deps)).code).toBe(0);
    expect(budget.output()).toContain("Cron");
    const broken = harness({ "node scripts/backfill.mjs": fail("HTTP 401", 1) });
    const res = await runRelease(opts(), broken.deps);
    expect(res.code).toBe(3);
    expect(broken.ran("bash scripts/smoke.sh")).toHaveLength(2); // 후속 작업이 실패해도 배포 뒤 스모크까지
  });
});

describe("infra: npm run release — 배포 전 중단", () => {
  const deployedNothing = (h: ReturnType<typeof harness>) => {
    expect(h.ran("npm run deploy")).toHaveLength(0);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
  };

  it("infra: feat/mvp·main이 아닌 브랜치, 더러운 작업 트리, 푸시 안 된 HEAD는 거절", async () => {
    for (const [over, msg] of [
      [{ "git rev-parse --abbrev-ref HEAD": ok("feat/admin-ops\n") }, "feat/admin-ops"],
      [{ "git status --porcelain": ok(" M worker/index.ts\n") }, "worker/index.ts"],
      [{ "git rev-parse origin/feat/mvp": ok("0000000000000000000000000000000000000000\n") }, "origin/feat/mvp"],
    ] as const) {
      const h = harness(over);
      const res = await runRelease(opts(), h.deps);
      expect(res.code, msg).toBe(1);
      expect(h.output()).toContain(msg);
      expect(h.ran("npm run typecheck")).toHaveLength(0);
      deployedNothing(h);
    }
  });

  it("infra: main 브랜치도 된다", async () => {
    const h = harness({
      "git rev-parse --abbrev-ref HEAD": ok("main\n"),
      "git fetch --quiet origin main": ok(),
      "git rev-parse origin/main": ok(SHA + "\n"),
    });
    expect((await runRelease(opts(), h.deps)).code).toBe(0);
  });

  it("infra: 테스트 실패·빌드 결과의 %VITE_ 자리표시자·없는 비밀값 이름은 거절", async () => {
    const t = harness({ "npm test": fail("1 failed") });
    expect((await runRelease(opts(), t.deps)).code).toBe(1);
    expect(t.ran("npm run build")).toHaveLength(0);
    deployedNothing(t);

    const v = harness({}, { files: { "dist/client/index.html": "appkey=%VITE_KAKAO_JS_KEY%" } });
    expect((await runRelease(opts(), v.deps)).code).toBe(1);
    expect(v.output()).toContain("%VITE_");
    deployedNothing(v);

    const s = harness({ "npx wrangler secret list --format json": ok('[{"name":"KAKAO_REST_KEY","type":"secret_text"}]') });
    expect((await runRelease(opts(), s.deps)).code).toBe(1);
    expect(s.output()).toContain("ADMIN_TOKEN");
    expect(s.ran("npx wrangler d1")).toHaveLength(0);
  });

  it("infra: --skip-tests --force면 typecheck·test를 건너뛰지만 빌드는 한다", async () => {
    const h = harness();
    expect((await runRelease(opts({ skipTests: true, force: true }), h.deps)).code).toBe(0);
    expect(h.ran("npm run typecheck")).toHaveLength(0);
    expect(h.ran("npm test")).toHaveLength(0);
    expect(h.ran("npm run build")).toHaveLength(1);
  });

  it("infra: D1 일일 한도(7500)면 '한도 리셋(09:00 KST) 뒤 다시'로 멈춘다", async () => {
    const h = harness({ "npx wrangler d1 execute momeokjo --remote --json --command SELECT 1": fail(D1_LIMIT_ERROR) });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(1);
    expect(h.output()).toContain("한도 리셋(09:00 KST) 뒤 다시");
    expect(h.ran("npx wrangler d1 migrations")).toHaveLength(0);
    deployedNothing(h);
  });

  it("infra: 마이그레이션 목록을 못 읽으면 멈춘다", async () => {
    const h = harness({ "npx wrangler d1 migrations list momeokjo --remote": ok("something new\n") });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    deployedNothing(h);
  });

  it("infra: 남은 마이그레이션의 객체가 이미 있으면(일부 적용) 적용하지 않고 멈춘다", async () => {
    const h = harness({ [LIST_JSON_CHECK]: ok(d1Rows(PLACES_COLUMNS_0005)) });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    expect(h.output()).toContain("손으로");
    expect(h.ran("npx wrangler d1 migrations apply")).toHaveLength(0);
    deployedNothing(h);
  });

  it("infra: 파괴적인 마이그레이션은 --allow-destructive 없이 적용하지 않는다", async () => {
    const replies = {
      "npx wrangler d1 migrations list momeokjo --remote": [ok("Migrations to be applied:\n│ 0006_drop.sql │\n"), ok(MIGRATIONS_NONE)],
    };
    const files = { "migrations/0006_drop.sql": "DROP INDEX idx_events_day;" };
    const h = harness(replies, { files });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    expect(h.output()).toContain("--allow-destructive");
    expect(h.ran("npx wrangler d1 migrations apply")).toHaveLength(0);
    deployedNothing(h);

    const allowed = harness(replies, { files });
    expect((await runRelease(opts({ allowDestructive: true }), allowed.deps)).code).toBe(0);
    expect(allowed.ran("npx wrangler d1 migrations apply")).toHaveLength(1);
  });

  it("infra: 마이그레이션 적용이 실패하면(한도 포함) 배포하지 않는다", async () => {
    const h = harness({ "npx wrangler d1 migrations apply momeokjo --remote": fail("✘ [ERROR] " + D1_LIMIT_ERROR) });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    expect(h.output()).toContain("한도 리셋(09:00 KST) 뒤 다시");
    deployedNothing(h);
    // 운영 D1을 건드렸으니 기록은 남긴다
    expect(h.appended[0].text).toContain("배포 전 중단");
  });

  it("infra: 적용 뒤에도 남은 마이그레이션이 있거나 사후 확인이 틀리면 배포하지 않는다", async () => {
    const pending = harness({ "npx wrangler d1 migrations list momeokjo --remote": ok(MIGRATIONS_PENDING_0005_ANSI) });
    expect((await runRelease(opts(), pending.deps)).code).toBe(1);
    deployedNothing(pending);

    const check = harness({ [LIST_JSON_CHECK]: ok(d1Rows(PLACES_COLUMNS)) });
    expect((await runRelease(opts(), check.deps)).code).toBe(1);
    expect(check.output()).toContain("list_json");
    deployedNothing(check);
  });

  it("infra: 후속 작업에 필요한 ADMIN_TOKEN이 없으면 적용 전에 멈춘다", async () => {
    const h = harness({}, { adminToken: null });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    expect(h.ran("npx wrangler d1 migrations apply")).toHaveLength(0);
  });

  it("infra: --yes 없이 터미널이 아니면 멈추고, 터미널에서 '아니요'면 취소", async () => {
    const pipe = harness({}, { isTTY: false });
    expect((await runRelease(opts({ yes: false }), pipe.deps)).code).toBe(1);
    expect(pipe.output()).toContain("--yes");
    expect(pipe.ran("npx wrangler d1 migrations apply")).toHaveLength(0);

    const no = harness({}, { isTTY: true, confirm: false });
    expect((await runRelease(opts({ yes: false }), no.deps)).code).toBe(1);
    expect(no.ran("npx wrangler d1 migrations apply")).toHaveLength(0);
    deployedNothing(no);
    expect(no.appended).toEqual([]);

    const yes = harness({}, { isTTY: true, confirm: true });
    expect((await runRelease(opts({ yes: false }), yes.deps)).code).toBe(0);
  });

  it("infra: 트래픽이 나뉘어 롤백 대상을 못 정하면 배포하지 않는다 — 마이그레이션을 적용하기 전에 멈춘다 (스키마를 바꾸고 1로 끝나지 않게)", async () => {
    const split = JSON.stringify([{ created_on: "2026-10-06T00:00:00Z", versions: [{ version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 }] }]);
    const h = harness({ "npx wrangler deployments list --json": ok(split) });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    deployedNothing(h);
    expect(h.ran("npx wrangler d1 migrations apply")).toHaveLength(0);
    expect(h.appended).toEqual([]);
  });

  it("infra: 배포 명령이 실패하고 활성 버전이 그대로면 '배포 안 됨'(1), 롤백하지 않는다", async () => {
    const h = harness({ "npm run deploy": fail("✘ [ERROR] build failed") });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    expect(h.ran("bash scripts/smoke.sh")).toHaveLength(1); // 기준 스모크만
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
  });

  it("infra: 확인 질문·기준 스모크 뒤 배포 직전에 트리가 더러워졌거나 HEAD가 바뀌면 배포하지 않는다", async () => {
    const dirty = harness({ "git status --porcelain": [ok(""), ok(" M worker/index.ts\n")] });
    expect((await runRelease(opts(), dirty.deps)).code).toBe(1);
    expect(dirty.output()).toContain("worker/index.ts");
    deployedNothing(dirty);

    const moved = harness({ "git rev-parse HEAD": [ok(SHA + "\n"), ok("1111111111111111111111111111111111111111\n")] });
    expect((await runRelease(opts(), moved.deps)).code).toBe(1);
    deployedNothing(moved);
  });

  it("infra: 마이그레이션을 적용했는데 배포 전에 멈추면 남은 후속 작업을 보여주고 기록·상태 파일에 남긴다", async () => {
    const h = harness({ "git status --porcelain": [ok(""), ok(" M worker/index.ts\n")] });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    deployedNothing(h);
    const out = h.output();
    expect(out).toContain("node scripts/backfill.mjs --hub ddp --limit 150");
    expect(h.appended[0].text).toMatch(/\| 0005_list_json \| 배포 전 중단 \(후속 작업 대기: 0005_list_json\) \|/);
    const state = h.written.find((w) => w.path === ".wrangler/release-pending-hooks.json");
    expect(JSON.parse(state!.text)).toHaveLength(HUBS.length);
    expect(state!.text).not.toContain(TOKEN);
  });

  it("infra: 다음 실행은 상태 파일의 후속 작업을 계획에 넣고, 배포 뒤 돌린 다음 비운다", async () => {
    const carried = HUBS.map((id) => ({ migration: "0005_list_json.sql", name: "list_json 백필", cmd: "node", args: ["scripts/backfill.mjs", "--hub", id, "--limit", "150"], needsAdminToken: true }));
    const h = harness(
      { "npx wrangler d1 migrations list momeokjo --remote": ok(MIGRATIONS_NONE) },
      { files: { ".wrangler/release-pending-hooks.json": JSON.stringify(carried) } },
    );
    expect((await runRelease(opts(), h.deps)).code).toBe(0);
    expect(h.output()).toContain("지난 실행");
    expect(h.ran("node scripts/backfill.mjs")).toHaveLength(HUBS.length);
    expect(h.ran("npx wrangler d1 migrations apply")).toHaveLength(0);
    expect(JSON.parse(h.files[".wrangler/release-pending-hooks.json"])).toEqual([]);
  });

  it("infra: 배포 뒤 실패한 후속 작업은 상태 파일에 남는다", async () => {
    const h = harness({ "node scripts/backfill.mjs --hub ddp": fail("HTTP 401", 1) });
    expect((await runRelease(opts(), h.deps)).code).toBe(3);
    const left = JSON.parse(h.files[".wrangler/release-pending-hooks.json"]);
    expect(left.map((x: { args: string[] }) => x.args[2])).toEqual(["ddp"]);
  });

  it("infra: 마이그레이션 적용이 실패하면 기록에 '(적용 실패)'로 남긴다", async () => {
    const h = harness({
      "npx wrangler d1 migrations apply momeokjo --remote": fail("✘ [ERROR] SQLITE_ERROR"),
      // 실패한 마이그레이션은 wrangler가 되돌려 그대로 남아 있다
      "npx wrangler d1 migrations list momeokjo --remote": ok(MIGRATIONS_PENDING_0005_ANSI),
    });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    expect(h.appended[0].text).toMatch(/\| 0005_list_json \(적용 실패\) \| 배포 전 중단 \|/);
    expect(h.written.filter((w) => w.path === ".wrangler/release-pending-hooks.json")).toEqual([]);
  });

  it("infra: 일부만 적용되고 실패하면 목록을 다시 읽어 적용된 것을 가리고, 그 후속 작업을 남긴다", async () => {
    const both = "Migrations to be applied:\n│ 0005_list_json.sql │\n│ 0006_next.sql │\n";
    const onlyNext = "Migrations to be applied:\n│ 0006_next.sql │\n";
    const h = harness(
      {
        "npx wrangler d1 migrations list momeokjo --remote": [ok(both), ok(onlyNext)],
        "npx wrangler d1 migrations apply momeokjo --remote": fail("✘ [ERROR] 0006_next.sql: SQLITE_ERROR"),
      },
      { files: { "migrations/0006_next.sql": "CREATE TABLE next_t (id INTEGER);" } },
    );
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    deployedNothing(h);
    expect(h.appended[0].text).toMatch(/\| 0005_list_json, 0006_next \(적용 실패 — 적용됨: 0005_list_json\) \| 배포 전 중단 \(후속 작업 대기: 0005_list_json\) \|/);
    expect(JSON.parse(h.files[".wrangler/release-pending-hooks.json"])).toHaveLength(HUBS.length);
    expect(h.output()).toContain("node scripts/backfill.mjs --hub ddp --limit 150");
  });

  it("infra: 상태 파일이 깨졌거나 허용되지 않은 명령이 있으면 경고하고 .corrupt로 남긴 뒤 계속 (허용된 것만 돌림)", async () => {
    const garbage = "{ not json";
    const g = harness({ "npx wrangler d1 migrations list momeokjo --remote": ok(MIGRATIONS_NONE) }, { files: { ".wrangler/release-pending-hooks.json": garbage } });
    expect((await runRelease(opts(), g.deps)).code).toBe(0);
    // 시작 시각(UTC)을 붙여 남긴다 — 여러 번 깨져도 덮어쓰지 않게
    expect(g.written).toContainEqual({ path: ".wrangler/release-pending-hooks.json.corrupt-20261006T000001Z", text: garbage });
    expect(g.output()).toContain(".corrupt-20261006T000001Z");

    const evil = JSON.stringify([
      { migration: "0005_list_json.sql", name: "x", cmd: "bash", args: ["-c", "echo pwned"], needsAdminToken: false },
      { migration: "0005_list_json.sql", name: "list_json 백필", cmd: "node", args: ["scripts/backfill.mjs", "--hub", "ddp", "--limit", "150"], needsAdminToken: true },
    ]);
    const e = harness({ "npx wrangler d1 migrations list momeokjo --remote": ok(MIGRATIONS_NONE) }, { files: { ".wrangler/release-pending-hooks.json": evil } });
    expect((await runRelease(opts(), e.deps)).code).toBe(0);
    expect(e.calls.some((c) => c.line.includes("echo pwned"))).toBe(false);
    expect(e.ran("node scripts/backfill.mjs --hub ddp")).toHaveLength(1);
    expect(e.written).toContainEqual({ path: ".wrangler/release-pending-hooks.json.corrupt-20261006T000001Z", text: evil });
  });

  it("infra: 적용이 실패하고 목록 다시 읽기도 실패하면(적용 여부 불명) 남은 마이그레이션 모두의 후속 작업을 경고와 함께 남긴다", async () => {
    const h = harness({
      "npx wrangler d1 migrations list momeokjo --remote": [ok(MIGRATIONS_PENDING_0005_ANSI), fail(D1_LIMIT_ERROR)],
      "npx wrangler d1 migrations apply momeokjo --remote": fail("✘ [ERROR] network"),
    });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    deployedNothing(h);
    expect(h.output()).toContain("어디까지 적용됐는지 몰라요");
    expect(JSON.parse(h.files[".wrangler/release-pending-hooks.json"])).toHaveLength(HUBS.length);
    expect(h.appended[0].text).toMatch(/\| 0005_list_json \(적용 실패 — 적용 여부 불명\) \| 배포 전 중단 \(후속 작업 대기: 0005_list_json\) \|/);
  });
});

describe("infra: npm run release — 배포는 됐는데 새 버전을 모를 때", () => {
  const expectUnknown = async (over: Record<string, Reply | Reply[]>) => {
    const h = harness(over);
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    const out = h.output();
    expect(out).toContain("배포됨 — 버전 불명, 확인 필요");
    expect(out).toContain(`npx wrangler rollback ${PREV_VERSION}`);
    expect(h.appended[0].text).toContain("배포됨 — 버전 불명, 확인 필요");
    expect(h.appended[0].text).not.toContain("배포 전 중단");
    expect(h.appended[0].text).toMatch(/^\| [\d-]+ [\d:]+ \| \? \|/);
    expect(h.ran("bash scripts/smoke.sh")).toHaveLength(1); // 기준만, 배포 뒤 스모크·롤백 없음
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
    // 후속 작업은 시작 전이라 보여주고 남긴다 (배포됐든 아니든)
    expect(h.ran("node scripts/backfill.mjs")).toHaveLength(0);
    expect(out).toContain("node scripts/backfill.mjs --hub ddp --limit 150");
    expect(JSON.parse(h.files[".wrangler/release-pending-hooks.json"])).toHaveLength(HUBS.length);
    expect(h.appended[0].text).toContain("후속 작업 대기: 0005_list_json");
  };

  it("infra: 'Current Version ID'가 없고 deployments list도 실패", async () => {
    await expectUnknown({
      "npm run deploy": ok("Uploaded momeokjo\n"),
      "npx wrangler deployments list --json": [ok(deploymentsJson(PREV_VERSION)), fail("✘ [ERROR] fetch failed")],
    });
  });

  it("infra: 'Current Version ID'가 없고 트래픽이 나뉨", async () => {
    const split = JSON.stringify([{ created_on: "2026-10-06T00:30:00Z", versions: [{ version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 }] }]);
    await expectUnknown({ "npm run deploy": ok("Uploaded momeokjo\n"), "npx wrangler deployments list --json": [ok(deploymentsJson(PREV_VERSION)), ok(split)] });
  });

  it("infra: 'Current Version ID'가 없고 활성 버전이 그대로", async () => {
    await expectUnknown({ "npm run deploy": ok("Uploaded momeokjo\n") });
  });
});

describe("infra: npm run release — 기준 스모크와 자동 롤백", () => {
  /** [배포 전 기준, 배포 뒤] 스모크 응답 */
  const smokes = (before: string[], after: string[]) => ({
    "bash scripts/smoke.sh": [before.length ? fail("", 1, smokeOutput(before)) : ok(smokeOutput(0)), after.length ? fail("", 1, smokeOutput(after)) : ok(smokeOutput(0))],
  });

  it("R62: 거점을 공개하는 release(ready: true로 바꿈) — 기준 스모크에만 SMOKE_BASELINE=1이 붙고, 운영이 아직 400이어도 WARN뿐이라 플래그 없이 배포한다", async () => {
    const baseWarn = smokeOutput([]).replace("== 정적 파일", "== 정적 파일\n  WARN  공개 예정 gangnam: 운영은 아직 숨김 (400)");
    const h = harness({ "bash scripts/smoke.sh": [ok(baseWarn), ok(smokeOutput(0))] });
    const res = await runRelease(opts({ acceptBaselineFails: false }), h.deps);
    expect(res.code).toBe(0);
    expect(h.ran("npm run deploy")).toHaveLength(1);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
    const smokeCalls = h.ran("bash scripts/smoke.sh");
    expect(smokeCalls).toHaveLength(2);
    expect(smokeCalls[0].env.SMOKE_BASELINE).toBe("1");
    // 배포 뒤 스모크는 운영자 셸에 남은 SMOKE_BASELINE=1을 덮어 늘 엄격하다 (deploy.mjs는 process.env 위에 더한다)
    expect(smokeCalls[1].env.SMOKE_BASELINE).toBe("0");
  });

  it("R67: 스모크 감사는 공개 거점 한 곳만 — release가 고른 거점(SMOKE_AUDIT_PICK)을 기준·배포 뒤 스모크에 같은 값으로 준다", async () => {
    const h = harness({}, { publicHubIds: ["bongeunsa", "ddp", "pangyo"] });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(0);
    const picks = h.ran("bash scripts/smoke.sh").map((c) => c.env.SMOKE_AUDIT_PICK);
    // 운영자 셸에 남은 SMOKE_AUDIT_ALL=1(모든 거점 감사 — R67이 줄인 D1 읽기를 되살린다)은 덮어 끈다
    expect(h.ran("bash scripts/smoke.sh").map((c) => c.env.SMOKE_AUDIT_ALL)).toEqual(["", ""]);
    expect(picks).toHaveLength(2);
    expect(picks[0]).toBe(picks[1]);
    expect(["bongeunsa", "ddp", "pangyo"]).toContain(picks[0]);
    expect(smokeAuditPick(["a", "b", "c"], Date.UTC(2026, 0, 1))).toBe(smokeAuditPick(["a", "b", "c"], Date.UTC(2026, 0, 1, 23)));
    expect(new Set([0, 1, 2].map((d) => smokeAuditPick(["a", "b", "c"], Date.UTC(2026, 0, 1 + d))))).toEqual(new Set(["a", "b", "c"]));
    expect(smokeAuditPick([], Date.UTC(2026, 0, 1))).toBeUndefined();
  });

  it("R62: 배포 뒤에도 공개한 거점이 400이면(코드 FAIL, 기준에는 없던 줄) 계속될 때 롤백한다 — 플래그 없는 스모크", async () => {
    const h = harness(smokes([], ["gangnam 500m → 400"]));
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(2);
    expect(h.ran("npx wrangler rollback")).toHaveLength(1);
    // 기준·배포 뒤·다시 돌린 것 중 기준만 SMOKE_BASELINE
    expect(h.ran("bash scripts/smoke.sh").map((c) => c.env.SMOKE_BASELINE)).toEqual(["1", "0", "0"]);
  });

  it("R62: 준비 중 거점이 배포 뒤에 200이면(숨김이 새는 코드) 새 코드 FAIL이라 롤백한다", async () => {
    const h = harness(smokes([], ["준비 중 gangnam 목록 숨김 → 200 (기대 400)"]), { hubIds: [...HUBS, "gangnam"], publicHubIds: HUBS });
    expect((await runRelease(opts(), h.deps)).code).toBe(2);
    expect(h.ran("npx wrangler rollback")).toHaveLength(1);
  });

  it("R63: 롤백 대상의 커밋(docs/deploys.md)의 crons가 이번 배포와 다르면 배포 전에 알리고, 자동 롤백 뒤 되돌릴 crons와 명령을 크게 알리고 종료 코드 3 (wrangler rollback은 트리거를 되돌리지 않는다)", async () => {
    const h = harness({ ...smokes([], [FAIL_PLACES_500]), "git show": ok(cronsConfig(["*/5 * * * *", "1-59/2 * * * *"])) });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    expect(h.ran("git show").map((c) => c.line)).toEqual([`git show ${PREV_COMMIT}:wrangler.jsonc`]);
    expect(h.ran("npx wrangler rollback")).toHaveLength(1);
    expect(res.summary.rolledBack).toBe(true);
    const note = "Cron 트리거를 */5 * * * *, 1-59/2 * * * *(으)로 되돌려야 해요";
    expect(res.summary.result).toContain(note);
    expect(h.appended[0].text).toContain(note);
    const out = h.output();
    expect(out).toContain(`npx wrangler triggers deploy --triggers "*/5 * * * *" --triggers "1-59/2 * * * *"`);
    expect(out).toContain("지금 운영 트리거는 */5 * * * *, * * * * *예요");
    // 배포 전(롤백 대상 기록)에도 알린다
    const before = out.slice(0, out.indexOf("== 6. 배포"));
    expect(before).toContain(`롤백 대상(${PREV_COMMIT})의 Cron 트리거는 */5 * * * *, 1-59/2 * * * *이고 이번 배포는 */5 * * * *, * * * * *예요`);
  });

  it("R63: 롤백 대상과 이번 배포의 crons가 같으면(지금 설정이 * * * * *여도) 트리거 경고 없이 자동 롤백 종료 코드 2 — 예전처럼 늘 1-59/2로 되돌리라고 하지 않는다", async () => {
    const h = harness(smokes([], [FAIL_PLACES_500]));
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(2);
    expect(res.summary.result).toBe("롤백 (새 FAIL 1)");
    const out = h.output();
    expect(out).not.toContain("되돌려야 해요");
    expect(out).not.toContain("1-59/2");
    expect(out).toContain(`롤백 대상(${PREV_COMMIT})과 Cron 트리거가 같아요`);
  });

  it("R63: 롤백 대상의 커밋을 모르면(배포 기록에 없음·git show 실패) 트리거를 비교하지 못했다고 알리고 자동 롤백 뒤 종료 코드 3 (사람이 확인)", async () => {
    const unknown = harness(smokes([], [FAIL_PLACES_500]), { files: { "docs/deploys.md": DEPLOY_LOG_EMPTY } });
    const res = await runRelease(opts(), unknown.deps);
    expect(res.code).toBe(3);
    expect(unknown.ran("git show")).toHaveLength(0);
    expect(res.summary.result).toContain("Cron 트리거 확인 필요");
    expect(unknown.output()).toContain("Cron 트리거를 비교하지 못했어요");
    const failed = harness({ ...smokes([], [FAIL_PLACES_500]), "git show": fail("fatal: invalid object name") });
    expect((await runRelease(opts(), failed.deps)).code).toBe(3);
    expect(failed.output()).toContain("Cron 트리거를 비교하지 못했어요");
  });

  it("infra: 배포 뒤 이 컴퓨터의 네트워크가 끊기면(실제 스모크 출력, 두 번 모두 → 000) 좋은 배포를 되돌리지 않고 확인 필요 3 + 롤백 명령", async () => {
    const h = harness({ "bash scripts/smoke.sh": [ok(smokeOutput(0)), fail("", 1, SMOKE_ALL_DOWN), fail("", 1, SMOKE_ALL_DOWN)] });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
    expect(h.ran("bash scripts/smoke.sh")).toHaveLength(3);
    expect(res.summary.result).toContain("연결 실패(000)");
    expect(h.output()).toContain(`npx wrangler rollback ${PREV_VERSION}`);
  });

  it("infra: 기준에 없던 코드 수준 FAIL이 새로 생기면 기록한 버전으로 비대화식 롤백(--message, --yes), 종료 코드 2", async () => {
    const h = harness(smokes([], [FAIL_PLACES_500, FAIL_ASSET_NEW]));
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(2);
    const rb = h.ran("npx wrangler rollback");
    expect(rb).toHaveLength(1);
    expect(rb[0].line).toMatch(new RegExp(`^npx wrangler rollback ${PREV_VERSION} --message .+ --yes$`));
    expect(res.summary).toMatchObject({ rolledBack: true, smoke: { fails: 2, newFails: [FAIL_PLACES_500, FAIL_ASSET_NEW] } });
    const out = h.output();
    expect(out).toContain(FAIL_PLACES_500);
    expect(out).toContain("마이그레이션은 되돌리지 않아요");
    expect(out).toMatch(/[Cc]ron/);
    expect(h.appended[0].text).toMatch(/\| 72a9f970 \| fc22b79 \| 0005_list_json \| 롤백 \(새 FAIL 2\) \| 2f5adde0 \|/);
    // 롤백 전에 20초 기다려 한 번 더 돌려 본다 (기준 + 배포 뒤 + 다시)
    expect(h.ran("bash scripts/smoke.sh")).toHaveLength(3);
    expect(h.sleeps).toContain(20_000);
  });

  it("infra: 다시 돌리니 사라진 일시 FAIL로는 롤백하지 않지만 사람이 보게 종료 코드 3 '일시 FAIL — 확인 필요'", async () => {
    const h = harness({ "bash scripts/smoke.sh": [ok(smokeOutput(0)), fail("", 1, smokeOutput([FAIL_PLACES_500])), ok(smokeOutput(0))] });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
    expect(h.ran("bash scripts/smoke.sh")).toHaveLength(3);
    expect(res.summary.result).toContain("일시 FAIL — 확인 필요");
    expect(h.appended[0].text).toContain("일시 FAIL — 확인 필요");
    // 처음 본 새 FAIL은 다시 돌린 뒤에도 요약에 남는다
    expect(res.summary.smoke).toMatchObject({ fails: 0, newFails: [], firstNewFails: [FAIL_PLACES_500] });
  });

  it("infra: 다시 돌린 스모크 결과를 못 읽으면 롤백하지 않고 확인 필요(3) — 결과에 이유", async () => {
    const h = harness({ "bash scripts/smoke.sh": [ok(smokeOutput(0)), fail("", 1, smokeOutput([FAIL_PLACES_500])), fail("curl: (6)", 2)] });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
    expect(h.output()).toContain(`npx wrangler rollback ${PREV_VERSION}`);
    expect(res.summary.result).toContain("다시 돌린 스모크");
    expect(res.summary.smoke).toMatchObject({ firstNewFails: [FAIL_PLACES_500] });
  });

  it("infra: 다시 돌리니 다른 FAIL만 보이면(흔들림) 확인 필요(3) — 결과에 '흔들려요'", async () => {
    const h = harness({
      "bash scripts/smoke.sh": [ok(smokeOutput(0)), fail("", 1, smokeOutput([FAIL_PLACES_500])), fail("", 1, smokeOutput([FAIL_ASSET_NEW]))],
    });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
    expect(res.summary.result).toContain("흔들려요");
  });

  it("infra: 배포 전 데이터(감사 200 미통과)였던 확인이 배포 뒤 코드(감사 500)로 바뀌면 롤백", async () => {
    const h = harness(smokes([FAIL_AUDIT], [FAIL_AUDIT_500]));
    expect((await runRelease(opts(), h.deps)).code).toBe(2);
    expect(h.ran("npm run deploy")).toHaveLength(1); // 기준이 데이터뿐이라 플래그 없이 진행
    expect(h.ran("npx wrangler rollback")).toHaveLength(1);
  });

  it("infra: 새 감사 HTTP 실패(500)와 모든 거점 '0곳'은 코드 회귀라 (계속되면) 롤백", async () => {
    const audit = harness(smokes([], [FAIL_AUDIT_500]));
    expect((await runRelease(opts(), audit.deps)).code).toBe(2);
    expect(audit.ran("npx wrangler rollback")).toHaveLength(1);

    const empty = harness(smokes([], HUBS.map(emptyFail)));
    expect((await runRelease(opts(), empty.deps)).code).toBe(2);
    expect(empty.ran("npx wrangler rollback")).toHaveLength(1);
  });

  it("R62: 준비 중 거점이 있어도 공개 거점이 모두 '0곳'이면 코드 회귀로 보고 롤백한다 (백필 훅은 모든 거점)", async () => {
    const all = [...HUBS, "gangnam", "yeouido", "gwanghwamun"];
    const h = harness(smokes([], HUBS.map(emptyFail)), { hubIds: all, publicHubIds: HUBS });
    expect((await runRelease(opts(), h.deps)).code).toBe(2);
    expect(h.ran("npx wrangler rollback")).toHaveLength(1);
    expect(h.ran("node scripts/backfill.mjs").map((c) => c.line)).toEqual(all.map((id) => `node scripts/backfill.mjs --hub ${id} --limit 150`));
  });

  it("infra: 기준 FAIL이 모두 데이터 상태 신호면 플래그 없이도 경고만 하고 진행", async () => {
    const h = harness(smokes([FAIL_AUDIT, FAIL_EMPTY], [FAIL_AUDIT, FAIL_EMPTY]));
    const res = await runRelease(opts({ yes: true }), h.deps);
    expect(res.code).toBe(0);
    expect(h.ran("npm run deploy")).toHaveLength(1);
    expect(h.output()).toContain(FAIL_AUDIT);
    expect(h.output()).toMatch(/데이터 상태/);
  });

  it("infra: 배포 전부터 있던 FAIL은 배포 뒤에도 롤백 사유가 아니다 (--accept-baseline-fails로 받아들였을 때)", async () => {
    const h = harness(smokes([FAIL_PLACES_500, FAIL_ASSET_OLD], [FAIL_PLACES_000, FAIL_ASSET_NEW]));
    const res = await runRelease(opts({ acceptBaselineFails: true }), h.deps);
    expect(res.code).toBe(0);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
    expect(h.output()).toContain(FAIL_PLACES_500); // 기준 FAIL을 보여준다
    expect(res.summary.result).toContain("기준 FAIL 2");
  });

  it("infra: 기준 스모크에 FAIL이 있으면 --accept-baseline-fails 없이는 배포 전에 멈춘다 — --yes(비대화식)도 받아들이지 않음", async () => {
    const stop = harness(smokes([FAIL_PLACES_500], []), { isTTY: true, confirm: true });
    expect((await runRelease(opts({ yes: false }), stop.deps)).code).toBe(1);
    expect(stop.output()).toContain(FAIL_PLACES_500);
    expect(stop.output()).toContain("--accept-baseline-fails");
    expect(stop.ran("npm run deploy")).toHaveLength(0);

    // --yes로 도는 비대화식 실행도 기준이 빨가면 FAIL을 보여주고 배포 전에 멈춘다 (종료 코드 1)
    const unattended = harness(smokes([FAIL_PLACES_500, FAIL_AUDIT], []), { isTTY: false });
    const res = await runRelease(opts({ yes: true }), unattended.deps);
    expect(res.code).toBe(1);
    expect(unattended.output()).toContain(FAIL_PLACES_500);
    expect(unattended.output()).toContain(FAIL_AUDIT);
    expect(unattended.output()).toContain("--accept-baseline-fails");
    expect(unattended.ran("npm run deploy")).toHaveLength(0);
    expect(unattended.ran("npx wrangler rollback")).toHaveLength(0);

    const accepted = harness(smokes([FAIL_PLACES_500], [FAIL_PLACES_500]), { isTTY: true, confirm: true });
    expect((await runRelease(opts({ yes: false, acceptBaselineFails: true }), accepted.deps)).code).toBe(0);
    expect(accepted.ran("npm run deploy")).toHaveLength(1);
  });

  it("infra: 새 FAIL이 감사(Q1·Q2)·'200인데 0곳'뿐이면 롤백하지 않고 '데이터 상태 확인 필요'(3)", async () => {
    const h = harness(smokes([], [FAIL_AUDIT, FAIL_EMPTY]));
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
    expect(h.output()).toContain("데이터 상태 확인 필요");
    expect(h.output()).toContain(FAIL_AUDIT);
    expect(h.appended[0].text).toContain("데이터 상태 확인 필요");
  });

  it("infra: 기준 스모크 결과를 못 읽으면 배포하지 않는다", async () => {
    const h = harness({ "bash scripts/smoke.sh": fail("jq이(가) 필요해요", 2) });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    expect(h.ran("npm run deploy")).toHaveLength(0);
  });

  it("infra: 롤백까지 실패하면 종료 코드 3과 손으로 할 명령", async () => {
    const h = harness({ ...smokes([], [FAIL_PLACES_500]), "npx wrangler rollback": fail("✘ [ERROR] auth") });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    expect(h.output()).toContain(`npx wrangler rollback ${PREV_VERSION}`);
  });

  it("infra: 배포 뒤 스모크 결과를 못 읽으면 롤백하지 않고 확인 필요(3)", async () => {
    const h = harness({ "bash scripts/smoke.sh": [ok(smokeOutput(0)), fail("jq이(가) 필요해요", 2)] });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
  });
});

describe("infra: npm run release --dry-run", () => {
  it("infra: 읽기만 하고 계획을 보여준다 — 적용·배포·후속 작업·스모크·롤백·기록 없음", async () => {
    const h = harness();
    const res = await runRelease(opts({ dryRun: true, yes: false }), h.deps);
    expect(res.code).toBe(0);
    for (const p of ["npx wrangler d1 migrations apply", "npm run deploy", "node scripts/backfill.mjs", "bash scripts/smoke.sh", "npx wrangler rollback"]) {
      expect(h.ran(p), p).toHaveLength(0);
    }
    expect(h.appended).toEqual([]);
    const out = h.output();
    expect(out).toContain("0005_list_json.sql");
    expect(out).toContain(PREV_VERSION.slice(0, 8));
    expect(out).toContain("dry-run");
  });
});
