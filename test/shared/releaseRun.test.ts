// scripts/release.mjs runRelease를 가짜 실행기로 돌린다 — wrangler·npm·git·curl을 실제로 부르지 않는다
import { describe, expect, it } from "vitest";
import { runRelease, type ReleaseOpts, type RunResult } from "../../scripts/release.mjs";
import sql0003 from "../../migrations/0003_meta.sql?raw";
import sql0005 from "../../migrations/0005_list_json.sql?raw";
import {
  D1_LIMIT_ERROR,
  D1_SELECT_1,
  d1Rows,
  DEPLOY_OUTPUT,
  deploymentsJson,
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
  };
}

function harness(over: Record<string, Reply | Reply[]> = {}, extra: { files?: Record<string, string>; isTTY?: boolean; confirm?: boolean; adminToken?: string | null } = {}) {
  const replies = { ...happyReplies(), ...over };
  const used: Record<string, number> = {};
  const calls: Call[] = [];
  const logs: string[] = [];
  const appended: { path: string; text: string }[] = [];
  const files: Record<string, string> = {
    "dist/client/index.html": '<script src="https://dapi.kakao.com/v2/maps/sdk.js?appkey=abc&autoload=false"></script>',
    "migrations/0003_meta.sql": sql0003,
    "migrations/0005_list_json.sql": sql0005,
    "docs/deploys.md": "# 배포 기록\n\n| 날짜 (KST) | 버전 | 커밋 | 마이그레이션 | 결과 | 롤백 대상 |\n|---|---|---|---|---|---|\n",
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
    log: (s: string) => void logs.push(s),
    confirm: async () => extra.confirm ?? true,
    sleep: async () => {},
    now: () => (clock += 1000),
    isTTY: extra.isTTY ?? false,
    adminToken: extra.adminToken === null ? undefined : (extra.adminToken ?? TOKEN),
    hubIds: HUBS,
  };
  const ran = (prefix: string) => calls.filter((c) => c.line === prefix || c.line.startsWith(prefix + " "));
  return { deps, calls, logs, appended, ran, output: () => logs.join("\n") };
}

const opts = (o: Partial<ReleaseOpts> = {}): ReleaseOpts => ({ dryRun: false, skipTests: false, force: false, yes: true, allowDestructive: false, ...o });

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
      "npx wrangler d1 migrations apply momeokjo --remote",
      "npx wrangler deployments list --json",
      "npm run deploy",
      "node scripts/backfill.mjs --hub bongeunsa --limit 150",
      "bash scripts/smoke.sh",
    ];
    for (let i = 1; i < steps.length; i++) expect(idx(steps[i - 1]), `${steps[i - 1]} → ${steps[i]}`).toBeLessThan(idx(steps[i]));
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
    expect(h.ran("bash scripts/smoke.sh")).toHaveLength(1);
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
    expect(broken.ran("bash scripts/smoke.sh")).toHaveLength(1);
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

  it("infra: 트래픽이 나뉘어 롤백 대상을 못 정하면 배포하지 않는다", async () => {
    const split = JSON.stringify([{ created_on: "2026-10-06T00:00:00Z", versions: [{ version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 }] }]);
    const h = harness({ "npx wrangler deployments list --json": ok(split) });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    deployedNothing(h);
  });

  it("infra: 배포 명령이 실패하고 활성 버전이 그대로면 '배포 안 됨'(1), 롤백하지 않는다", async () => {
    const h = harness({ "npm run deploy": fail("✘ [ERROR] build failed") });
    expect((await runRelease(opts(), h.deps)).code).toBe(1);
    expect(h.ran("bash scripts/smoke.sh")).toHaveLength(0);
    expect(h.ran("npx wrangler rollback")).toHaveLength(0);
  });
});

describe("infra: npm run release — 스모크 실패와 자동 롤백", () => {
  it("infra: 스모크 FAIL > 0이면 기록해 둔 버전으로 비대화식 롤백(--message, --yes), 종료 코드 2", async () => {
    const h = harness({ "bash scripts/smoke.sh": fail("", 1, smokeOutput(2)) });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(2);
    const rb = h.ran("npx wrangler rollback");
    expect(rb).toHaveLength(1);
    expect(rb[0].line).toMatch(new RegExp(`^npx wrangler rollback ${PREV_VERSION} --message .+ --yes$`));
    expect(res.summary).toMatchObject({ rolledBack: true, smoke: { fails: 2 } });
    const out = h.output();
    expect(out).toContain("마이그레이션은 되돌리지 않아요");
    expect(out).toMatch(/[Cc]ron/);
    expect(h.appended[0].text).toMatch(/\| 72a9f970 \| fc22b79 \| 0005_list_json \| 롤백 \(스모크 FAIL 2\) \| 2f5adde0 \|/);
  });

  it("infra: 롤백까지 실패하면 종료 코드 3과 손으로 할 명령", async () => {
    const h = harness({ "bash scripts/smoke.sh": fail("", 1, smokeOutput(1)), "npx wrangler rollback": fail("✘ [ERROR] auth") });
    const res = await runRelease(opts(), h.deps);
    expect(res.code).toBe(3);
    expect(h.output()).toContain(`npx wrangler rollback ${PREV_VERSION}`);
  });

  it("infra: 스모크 결과를 못 읽으면 롤백하지 않고 확인 필요(3)", async () => {
    const h = harness({ "bash scripts/smoke.sh": fail("jq이(가) 필요해요", 2) });
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
