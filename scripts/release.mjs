// npm run release의 판단과 순서 (Task 32). 실제 명령 실행·파일 읽기·출력은 deps로 받는다 —
// scripts/deploy.mjs가 진짜 실행기를 넘기고, 테스트는 wrangler·npm·git·curl 출력을 흉내 낸 가짜 실행기를 넘긴다.
// node와 테스트(workerd) 둘 다에서 돌도록 node 모듈을 부르지 않는다. 단계는 docs/deploy.md에 설명한다.
import { MIGRATION_CHECKS, objectState } from "./migrationChecks.mjs";

export const DB_NAME = "momeokjo";
export const PROD_URL = "https://mmj.itmz.me";
export const RELEASE_BRANCHES = ["feat/mvp", "main"];
/** 이름만 확인한다 (값은 wrangler도 보여주지 않는다) */
export const REQUIRED_SECRETS = ["KAKAO_REST_KEY", "ADMIN_TOKEN"];
export const DEPLOY_LOG = "docs/deploys.md";
/** 작업 트리 확인에서 빼는 경로: 배포 기록(이 스크립트가 쓰고 운영자가 커밋), Claude Code 작업 폴더 (빌드에 안 들어감) */
export const DIRTY_IGNORED = ["docs/deploys.md", ".claude/"];
/** 배포 직후 새 버전이 퍼지길 기다리는 시간 (스모크 전) */
export const SMOKE_SETTLE_MS = 10_000;
export const DEPLOY_LOG_HEADER =
  "# 배포 기록\n\n" +
  "`npm run release`(scripts/deploy.mjs)가 운영을 바꿀 때마다 한 줄씩 더해요. 커밋은 운영자가 해요 (docs/deploy.md).\n\n" +
  "| 날짜 (KST) | 버전 | 커밋 | 마이그레이션 | 결과 | 롤백 대상 |\n" +
  "|---|---|---|---|---|---|\n";

const FLAGS = {
  "--dry-run": "dryRun",
  "--skip-tests": "skipTests",
  "--force": "force",
  "--yes": "yes",
  "-y": "yes",
  "--allow-destructive": "allowDestructive",
};

/**
 * @param {string[]} argv
 * @returns {{ ok: true, opts: import("./release.d.mts").ReleaseOpts } | { ok: false, error: string }}
 */
export function parseReleaseArgs(argv) {
  const opts = { dryRun: false, skipTests: false, force: false, yes: false, allowDestructive: false };
  for (const a of argv) {
    const key = FLAGS[a];
    if (!key) return { ok: false, error: `모르는 인자예요: ${a}\n사용법: npm run release [-- --dry-run] [--yes] [--allow-destructive] [--skip-tests --force]` };
    opts[key] = true;
  }
  if (opts.skipTests && !opts.force) return { ok: false, error: "--skip-tests는 --force와 함께만 써요 (테스트 없이 운영에 내보내는 건 예외 상황이에요)" };
  return { ok: true, opts };
}

export const stripAnsi = (s) => String(s ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");

/** 줄 맨 앞의 [ 부터 JSON 배열로 읽어 본다 (앞에 경고 줄이 붙어도 되게) */
function parseJsonArray(text) {
  const t = stripAnsi(text);
  for (const m of t.matchAll(/^[ \t]*\[/gm)) {
    try {
      const v = JSON.parse(t.slice(m.index));
      if (Array.isArray(v)) return v;
    } catch {
      // 다음 후보
    }
  }
  return null;
}

/**
 * `wrangler d1 migrations list <db> --remote` 출력 → 적용할 마이그레이션 이름 (순서대로).
 * 알아볼 수 없는 출력이면 null — 빈 목록(= 적용할 것 없음)과 구분한다.
 * @param {string} text
 * @returns {string[] | null}
 */
export function parsePendingMigrations(text) {
  const t = stripAnsi(text);
  if (/No migrations to apply/i.test(t)) return [];
  const at = t.search(/Migrations to be applied/i);
  if (at < 0) return null;
  const names = [...t.slice(at).matchAll(/\b(\d{4}_[A-Za-z0-9_.-]*?\.sql)\b/g)].map((m) => m[1]);
  return names.length ? [...new Set(names)] : null;
}

/**
 * 되돌릴 수 없는 문장을 찾는다 (주석·문자열·따옴표 이름은 빼고 본다). 빈 배열이면 더하기만 하는 마이그레이션.
 * @param {string} sql
 * @returns {string[]} "DROP" | "ALTER … DROP" | "RENAME" | "DELETE" (처음 나온 순서, 중복 없음)
 */
export function isDestructive(sql) {
  const clean = String(sql).replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`/g, (m) => (m.startsWith("'") ? "''" : " "));
  const found = [];
  const add = (r) => found.includes(r) || found.push(r);
  for (const st of clean.split(";")) {
    if (/^\s*ALTER\b/i.test(st) && /\bDROP\b/i.test(st)) add("ALTER … DROP");
    else if (/\bDROP\b/i.test(st)) add("DROP");
    if (/\bRENAME\b/i.test(st)) add("RENAME");
    if (/\bDELETE\s+FROM\b/i.test(st)) add("DELETE");
  }
  return found;
}

/**
 * `wrangler d1 execute --json` 출력 → 첫 문장의 결과 행. 오류 JSON·알아볼 수 없는 출력이면 null
 * @returns {Array<Record<string, unknown>> | null}
 */
export function parseD1Rows(text) {
  const v = parseJsonArray(text);
  const first = v?.[0];
  return first && Array.isArray(first.results) ? first.results : null;
}

/** D1 일일 한도(무료 플랜, 오류 코드 7500) — 00:00 UTC(09:00 KST)에 풀린다 */
export function isD1LimitError(text) {
  const t = stripAnsi(text);
  return /(?<![\d.])7500(?![\d.])/.test(t) || /exceeded[^\n]*\bdaily\b|\bdaily\b[^\n]*\blimit\b/i.test(t);
}

/** `wrangler secret list --format json` → 이름 목록 */
export function parseSecretNames(text) {
  const v = parseJsonArray(text);
  if (!v) return null;
  return v.map((s) => s?.name).filter((n) => typeof n === "string");
}

/** `wrangler deploy`(·rollback) 출력의 마지막 "Current Version ID: <id>" */
export function parseDeployVersionId(text) {
  const all = [...stripAnsi(text).matchAll(/Current Version ID:\s*([0-9a-f][0-9a-f-]{7,})/gi)];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * `wrangler deployments list --json`(또는 기본 출력) → 지금 트래픽 100%를 받는 버전 (롤백 대상).
 * 가장 최근 배포가 버전 하나에 100%가 아니면(점진 배포 중) 정하지 않는다.
 * @returns {{ ok: true, id: string } | { ok: false, error: string }}
 */
export function parseActiveVersion(text) {
  const arr = parseJsonArray(text);
  if (arr) {
    if (arr.length === 0) return { ok: false, error: "배포 기록이 비어 있어요" };
    const latest = [...arr].sort((a, b) => String(b?.created_on ?? "").localeCompare(String(a?.created_on ?? "")))[0];
    const versions = Array.isArray(latest?.versions) ? latest.versions : [];
    if (versions.length === 1 && Number(versions[0].percentage) === 100 && versions[0].version_id) return { ok: true, id: versions[0].version_id };
    return { ok: false, error: `가장 최근 배포의 트래픽이 나뉘어 있어요 (${versions.map((v) => `${v.version_id} ${v.percentage}%`).join(", ")})` };
  }
  const t = stripAnsi(text);
  const at = t.lastIndexOf("Version(s):");
  if (at < 0) return { ok: false, error: "deployments list 출력을 알아보지 못했어요" };
  const block = t.slice(at).split(/\n\s*\n(?=Created:)/)[0];
  const versions = [...block.matchAll(/\((\d+(?:\.\d+)?)%\)\s+([0-9a-f][0-9a-f-]{7,})/g)];
  if (versions.length === 1 && Number(versions[0][1]) === 100) return { ok: true, id: versions[0][2] };
  return { ok: false, error: "가장 최근 배포의 트래픽이 한 버전 100%가 아니에요" };
}

/** scripts/smoke.sh 마지막 줄 "요청 N번 · FAIL n · WARN n" */
export function parseSmokeSummary(text) {
  const all = [...stripAnsi(text).matchAll(/요청\s*(\d+)번\s*·\s*FAIL\s*(\d+)\s*·\s*WARN\s*(\d+)/g)];
  if (!all.length) return null;
  const m = all[all.length - 1];
  return { requests: Number(m[1]), fails: Number(m[2]), warns: Number(m[3]) };
}

/**
 * 스모크 뒤 할 일. FAIL이 있으면 롤백, 요약을 못 읽었거나 종료 코드와 어긋나면 운영을 함부로 되돌리지 않고 사람에게 넘긴다.
 * @param {{ code: number, summary: { requests: number, fails: number, warns: number } | null }} smoke
 * @returns {{ action: "keep" | "rollback" | "manual", reason: string }}
 */
export function shouldRollback({ code, summary }) {
  if (!summary) return { action: "manual", reason: `스모크 요약 줄을 읽지 못했어요 (종료 코드 ${code})` };
  if (summary.fails > 0) return { action: "rollback", reason: `스모크 FAIL ${summary.fails}` };
  if (code !== 0) return { action: "manual", reason: `스모크가 FAIL 0인데 종료 코드가 ${code}예요` };
  return { action: "keep", reason: `스모크 FAIL 0 · WARN ${summary.warns}` };
}

/** `git status --porcelain` → 배포를 막는 변경 경로 (DIRTY_IGNORED 제외) */
export function dirtyPaths(porcelain) {
  return String(porcelain)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const p = l.slice(3);
      return (p.includes(" -> ") ? p.split(" -> ")[1] : p).replace(/^"|"$/g, "");
    })
    .filter((p) => !DIRTY_IGNORED.some((ig) => (ig.endsWith("/") ? p.startsWith(ig) : p === ig)));
}

/**
 * 남은 마이그레이션으로 계획을 세운다 (원격 호출 없음).
 * @param {{ pending: string[], sqlByName: Record<string, string | undefined>, allowDestructive: boolean, hubIds: string[], hasAdminToken: boolean, checks?: typeof MIGRATION_CHECKS }} input
 */
export function planRelease({ pending, sqlByName, allowDestructive, hubIds, hasAdminToken, checks = MIGRATION_CHECKS }) {
  const errors = [];
  const hooks = [];
  const lines = ["계획"];
  lines.push(pending.length ? `  · 마이그레이션 적용 (--remote): ${pending.join(", ")}` : "  · 마이그레이션: 적용할 것 없음 → 건너뜀");
  for (const name of pending) {
    const sql = sqlByName[name];
    if (typeof sql !== "string") {
      errors.push(`${name}: migrations/${name}을(를) 읽지 못했어요`);
      continue;
    }
    const reasons = isDestructive(sql);
    if (reasons.length && !allowDestructive) {
      errors.push(`${name}: 되돌릴 수 없는 문장(${reasons.join(", ")})이 있어요 — 롤백해도 마이그레이션은 그대로라 더하기만 해요. 정말 필요하면 --allow-destructive`);
    } else if (reasons.length) {
      lines.push(`    ⚠ ${name}: ${reasons.join(", ")} (--allow-destructive) — 롤백해도 되돌아가지 않아요`);
    }
    const entry = checks[name];
    if (entry) for (const c of entry.checks) lines.push(`    ${name}: 적용 전에는 없고 적용 뒤에는 있는지 확인 — ${c.what}`);
    else lines.push(`    ${name}: 등록된 사후 확인 없음 (scripts/migrationChecks.mjs) — 남은 마이그레이션이 없는지만 봐요`);
    for (const hook of entry?.hooks ?? []) {
      if (hook.needsAdminToken && !hasAdminToken) errors.push(`${name}: 후속 작업 "${hook.name}"에 ADMIN_TOKEN이 필요해요 (환경 변수 또는 .dev.vars)`);
      for (const c of hook.commands(hubIds)) hooks.push({ migration: name, name: hook.name, cmd: c.cmd, args: c.args });
    }
  }
  lines.push("  · 롤백 대상 기록 (wrangler deployments list — 지금 100% 활성 버전)");
  lines.push("  · 배포 (npm run deploy)");
  if (hooks.length) {
    for (const name of new Set(hooks.map((h) => h.name))) {
      const hs = hooks.filter((h) => h.name === name);
      lines.push(`  · 후속 작업 (${hs[0].migration}): ${name} — ${hs.length}번`);
    }
  } else lines.push("  · 후속 작업: 없음 → 건너뜀");
  lines.push(`  · 스모크 (scripts/smoke.sh → ${PROD_URL}) — FAIL이 있으면 기록한 버전으로 자동 롤백`);
  return { ok: errors.length === 0, errors, migrations: [...pending], hooks, lines };
}

/** epoch ms → "yyyy-mm-dd HH:MM" (KST) */
export function kstStamp(ms) {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}

const short = (v) => (v ? String(v).slice(0, 8) : "-");

/** docs/deploys.md 표 한 줄 */
export function deployLogLine({ at, version, commit, migrations, result, previous }) {
  const migs = migrations.length ? migrations.map((n) => n.replace(/\.sql$/, "")).join(", ") : "-";
  const cell = (s) => String(s).replace(/\|/g, "/").replace(/\n/g, " ");
  return `| ${kstStamp(at)} | ${short(version)} | ${cell(commit ?? "-")} | ${cell(migs)} | ${cell(result)} | ${short(previous)} |`;
}

class Stop extends Error {
  /** @param {string} message @param {number} [code] @param {string} [result] docs/deploys.md 결과 칸 */
  constructor(message, code = 1, result) {
    super(message);
    this.code = code;
    this.result = result;
  }
}

const tail = (text, n = 15) => {
  const lines = stripAnsi(text).trim().split("\n");
  return (lines.length > n ? ["…", ...lines.slice(-n)] : lines).join("\n");
};

const ROLLBACK_CAVEATS = [
  "  ⚠ 마이그레이션은 되돌리지 않아요 — 그래서 마이그레이션은 더하기만 해요 (이전 버전도 새 스키마에서 돌아야 해요).",
  "  ⚠ wrangler rollback은 Cron 트리거를 되돌리지 않아요 — 지금 wrangler.jsonc의 crons가 그대로 남아요. 이전 버전이 다른 주기를 기대하면 손으로 맞추세요 (docs/deploy.md).",
  "  ⚠ 롤백 대상은 이번 배포 직전에 운영 중이던 버전이에요. 다른 버전으로 손으로 롤백할 때는 docs/deploy.md의 '안전한 롤백 대상'을 보세요.",
];

/**
 * npm run release 전체 흐름. 첫 실패에서 멈춘다.
 * 종료 코드: 0 성공 · 1 배포 전 중단(운영 코드는 그대로) · 2 스모크 실패 → 자동 롤백함 · 3 사람이 확인해야 함
 * @param {import("./release.d.mts").ReleaseOpts} opts
 * @param {import("./release.d.mts").ReleaseDeps} deps
 */
export async function runRelease(opts, deps) {
  const startedAt = deps.now();
  const log = deps.log;
  const summary = {
    dryRun: opts.dryRun,
    branch: null,
    commit: null,
    previousVersion: null,
    newVersion: null,
    migrationsPending: [],
    migrationsApplied: [],
    hooks: [],
    smoke: null,
    rolledBack: false,
    result: "",
    elapsedMs: 0,
  };
  const state = { touchedProd: false, deployed: false, listed: false };

  const exec = async (cmd, args, o = {}) => {
    log(`$ ${[cmd, ...args].join(" ")}`);
    const r = await deps.run(cmd, args, o);
    const stdout = r.stdout ?? "";
    const stderr = r.stderr ?? "";
    return { code: r.code, stdout, stderr, all: `${stdout}\n${stderr}` };
  };
  const mustRun = async (cmd, args, what) => {
    const r = await exec(cmd, args, { echo: true });
    if (r.code !== 0) throw new Stop(`${what}이(가) 실패했어요 (종료 코드 ${r.code})`);
    return r;
  };
  /** stdout 그대로 (porcelain은 앞 공백이 상태 칸이라 다듬지 않는다) */
  const gitRaw = async (...args) => {
    const r = await exec("git", args);
    if (r.code !== 0) throw new Stop(`git ${args.join(" ")} 실패:\n${tail(r.all)}`);
    return r.stdout;
  };
  const git = async (...args) => (await gitRaw(...args)).trim();
  const d1Stop = (r, what) =>
    isD1LimitError(r.all)
      ? new Stop(`D1 일일 한도(7500)에 걸렸어요 (${what}). 한도 리셋(09:00 KST) 뒤 다시 실행하세요.`)
      : new Stop(`${what} 실패:\n${tail(r.all)}`);
  const d1Query = async (sql, what) => {
    const r = await exec("npx", ["wrangler", "d1", "execute", DB_NAME, "--remote", "--json", "--command", sql]);
    const rows = r.code === 0 ? parseD1Rows(r.stdout) : null;
    if (!rows) throw d1Stop(r, what);
    return rows;
  };
  const listPending = async () => {
    const r = await exec("npx", ["wrangler", "d1", "migrations", "list", DB_NAME, "--remote"]);
    if (r.code !== 0) throw d1Stop(r, "마이그레이션 목록");
    const pending = parsePendingMigrations(r.all);
    if (pending === null) throw new Stop(`마이그레이션 목록을 알아보지 못했어요:\n${tail(r.all)}`);
    return pending;
  };
  const activeVersion = async () => {
    const r = await exec("npx", ["wrangler", "deployments", "list", "--json"]);
    if (r.code !== 0) throw new Stop(`wrangler deployments list 실패:\n${tail(r.all)}`);
    const v = parseActiveVersion(r.stdout);
    if (!v.ok) throw new Stop(`롤백 대상을 정하지 못했어요: ${v.error}`);
    return v.id;
  };
  const checksOf = (name) => MIGRATION_CHECKS[name]?.checks ?? [];

  const steps = async () => {
    // 1. 사전 확인 (로컬 + 비밀값 이름)
    log("== 1. 사전 확인");
    const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
    summary.branch = branch;
    if (!RELEASE_BRANCHES.includes(branch)) throw new Stop(`배포는 ${RELEASE_BRANCHES.join(" 또는 ")}에서만 해요 (지금: ${branch})`);
    const dirty = dirtyPaths(await gitRaw("status", "--porcelain"));
    if (dirty.length) throw new Stop(`작업 트리가 깨끗하지 않아요: ${dirty.join(", ")} — 커밋하거나 치우고 다시 하세요`);
    await git("fetch", "--quiet", "origin", branch);
    const head = await git("rev-parse", "HEAD");
    const remote = await git("rev-parse", `origin/${branch}`);
    summary.commit = head.slice(0, 7);
    if (head !== remote) throw new Stop(`HEAD(${head.slice(0, 7)})가 origin/${branch}(${remote.slice(0, 7)})와 달라요 — 푸시(또는 pull)해서 맞춘 뒤 다시 하세요`);
    log(`  ok ${branch}@${summary.commit}, 작업 트리 깨끗함, origin과 같음`);
    const tools = await exec("bash", ["-c", "command -v curl >/dev/null && command -v jq >/dev/null"]);
    if (tools.code !== 0) throw new Stop("스모크(scripts/smoke.sh)에 curl과 jq가 필요해요");
    if (opts.skipTests) log("  ⚠ --skip-tests --force: typecheck·test를 건너뛰어요");
    else {
      await mustRun("npm", ["run", "typecheck"], "npm run typecheck");
      await mustRun("npm", ["test"], "npm test");
    }
    await mustRun("npm", ["run", "build"], "npm run build");
    const html = deps.readFile("dist/client/index.html");
    if (html === undefined) throw new Stop("빌드 결과 dist/client/index.html이 없어요");
    if (html.includes("%VITE_")) throw new Stop("빌드 결과(dist/client/index.html)에 %VITE_ 자리표시자가 남았어요 — .env.local의 VITE_KAKAO_JS_KEY를 확인하세요");
    log("  ok 빌드 결과에 %VITE_ 자리표시자 없음");
    const secrets = await exec("npx", ["wrangler", "secret", "list", "--format", "json"]);
    const names = secrets.code === 0 ? parseSecretNames(secrets.stdout) : null;
    if (!names) throw new Stop(`wrangler secret list를 읽지 못했어요:\n${tail(secrets.all)}`);
    const missing = REQUIRED_SECRETS.filter((n) => !names.includes(n));
    if (missing.length) throw new Stop(`운영 비밀값이 없어요: ${missing.join(", ")} — npx wrangler secret put <이름>`);
    log(`  ok 운영 비밀값 이름 ${REQUIRED_SECRETS.join(", ")} 있음 (값은 보지 않아요)`);

    // 2. D1 접근
    log("== 2. D1 접근");
    await d1Query("SELECT 1", "운영 D1 SELECT 1");
    log("  ok 운영 D1 응답");

    // 3. 마이그레이션 — 계획·적용 전 확인
    log("== 3. 마이그레이션");
    const pending = await listPending();
    summary.migrationsPending = pending;
    state.listed = true;
    const sqlByName = Object.fromEntries(pending.map((n) => [n, deps.readFile(`migrations/${n}`)]));
    const plan = planRelease({ pending, sqlByName, allowDestructive: opts.allowDestructive, hubIds: deps.hubIds, hasAdminToken: Boolean(deps.adminToken) });
    if (!plan.ok) throw new Stop(plan.errors.join("\n"));
    for (const name of pending) {
      for (const c of checksOf(name)) {
        const st = objectState(await d1Query(c.sql, `${name} 적용 전 확인`), c.expect);
        if (st !== "none") {
          throw new Stop(`${name}이(가) 아직 적용 전인데 ${c.what} 중 일부가 이미 있어요 — 일부만 적용된 상태라 자동으로 적용하지 않아요. 손으로 맞추세요 (docs/deploy.md)`);
        }
      }
    }
    for (const l of plan.lines) log(l);

    if (opts.dryRun) {
      log("== 4. 롤백 대상 (읽기만)");
      summary.previousVersion = await activeVersion();
      log(`  지금 활성 버전(롤백 대상): ${summary.previousVersion}`);
      log("dry-run: 여기서 멈춰요 — 운영은 바꾸지 않았어요");
      summary.result = "dry-run (운영 변경 없음)";
      return 0;
    }
    if (!opts.yes) {
      if (!deps.isTTY) throw new Stop("확인할 터미널이 없어요 — 계획을 봤다면 --yes를 붙여 다시 실행하세요");
      if (!(await deps.confirm("위 계획대로 운영에 반영할까요? (y/N) "))) throw new Stop("취소했어요 — 운영은 바꾸지 않았어요");
    }

    if (pending.length) {
      state.touchedProd = true;
      const r = await exec("npx", ["wrangler", "d1", "migrations", "apply", DB_NAME, "--remote"], { echo: true });
      if (r.code !== 0) throw d1Stop(r, "마이그레이션 적용 — 실패한 마이그레이션은 wrangler가 되돌리고 앞의 것은 남아요");
      summary.migrationsApplied = [...pending];
      const left = await listPending();
      if (left.length) throw new Stop(`적용했는데도 남은 마이그레이션이 있어요: ${left.join(", ")}`);
      for (const name of pending) {
        for (const c of checksOf(name)) {
          const st = objectState(await d1Query(c.sql, `${name} 사후 확인`), c.expect);
          if (st !== "all") throw new Stop(`${name} 사후 확인 실패: ${c.what} — 기대한 것(${c.expect.join(", ")})이 다 있지 않아요`);
        }
      }
      log(`  ok 적용·확인: ${pending.join(", ")}`);
    }

    // 4. 롤백 대상 기록
    log("== 4. 롤백 대상 기록");
    const previous = await activeVersion();
    summary.previousVersion = previous;
    log(`  지금 활성 버전(롤백 대상): ${previous}`);

    // 5. 배포
    log("== 5. 배포");
    state.touchedProd = true;
    const dep = await exec("npm", ["run", "deploy"], { echo: true });
    if (dep.code !== 0) {
      let now = null;
      try {
        now = await activeVersion();
      } catch {
        // 아래에서 알 수 없음으로 알린다
      }
      if (now === previous) throw new Stop("배포 명령이 실패했어요 — 활성 버전은 그대로예요(반영 안 됨). 출력을 보고 고친 뒤 다시 하세요", 1, "배포 실패 (반영 안 됨)");
      summary.newVersion = now;
      throw new Stop(`배포 명령이 실패했는데 활성 버전이 ${now ?? "알 수 없음"}이에요 — 직접 확인하세요: npx wrangler deployments list (롤백: npx wrangler rollback ${previous})`, 3, "배포 실패 — 확인 필요");
    }
    let newVersion = parseDeployVersionId(dep.all);
    if (!newVersion) {
      newVersion = await activeVersion();
      if (newVersion === previous) throw new Stop("배포가 끝났다는데 활성 버전이 그대로예요 — 직접 확인하세요: npx wrangler deployments list", 3, "배포 반영 안 됨 — 확인 필요");
    }
    state.deployed = true;
    summary.newVersion = newVersion;
    log(`  새 버전: ${newVersion}`);

    // 6. 마이그레이션별 후속 작업 (이번에 적용한 것만)
    let hooksFailed = 0;
    if (plan.hooks.length) {
      log("== 6. 후속 작업");
      for (const h of plan.hooks) {
        const env = { MMJ_BASE: PROD_URL };
        if (deps.adminToken) env.ADMIN_TOKEN = deps.adminToken;
        const r = await exec(h.cmd, h.args, { echo: true, env });
        const result = r.code === 0 ? "ok" : r.code === 2 ? "budget" : "failed";
        summary.hooks.push({ migration: h.migration, name: h.name, command: [h.cmd, ...h.args].join(" "), result });
        if (result === "budget") log("  ⚠ D1 예산 소진 또는 요청 제한으로 멈췄어요 — 남은 행은 Cron이 실행마다 채워요");
        if (result === "failed") {
          hooksFailed++;
          log(`  ✗ 실패 (종료 코드 ${r.code}) — 스모크는 계속해요`);
        }
      }
    }

    // 7. 스모크 → 실패면 자동 롤백
    log(`== 7. 스모크 (${SMOKE_SETTLE_MS / 1000}초 기다린 뒤)`);
    await deps.sleep(SMOKE_SETTLE_MS);
    const smokeEnv = { B: PROD_URL };
    if (deps.adminToken) smokeEnv.ADMIN_TOKEN = deps.adminToken;
    const smoke = await exec("bash", ["scripts/smoke.sh"], { echo: true, env: smokeEnv });
    summary.smoke = parseSmokeSummary(smoke.all);
    const verdict = shouldRollback({ code: smoke.code, summary: summary.smoke });
    if (verdict.action === "keep") {
      log(`  ok ${verdict.reason}`);
      if (hooksFailed) {
        summary.result = "성공 (후속 작업 실패 — 확인 필요)";
        log(`  ⚠ 후속 작업 ${hooksFailed}개가 실패했어요 — 위 출력을 보고 손으로 다시 돌리세요`);
        return 3;
      }
      summary.result = "성공";
      return 0;
    }
    if (verdict.action === "manual") {
      summary.result = "확인 필요 (스모크 결과 불명)";
      log(`  ✗ ${verdict.reason} — 자동 롤백은 하지 않아요.`);
      log(`    직접 확인: B=${PROD_URL} scripts/smoke.sh`);
      log(`    되돌리려면: npx wrangler rollback ${previous} --message "수동 롤백"`);
      return 3;
    }
    const fails = summary.smoke.fails;
    log(`== 스모크 FAIL ${fails} → ${short(previous)}(으)로 자동 롤백`);
    const rb = await exec("npx", ["wrangler", "rollback", previous, "--message", `release: 스모크 FAIL ${fails} 자동 롤백 (${summary.commit})`, "--yes"], { echo: true });
    for (const c of ROLLBACK_CAVEATS) log(c);
    if (rb.code !== 0) {
      summary.result = `롤백 실패 (스모크 FAIL ${fails}) — 확인 필요`;
      log(`  ✗ 롤백이 실패했어요 (종료 코드 ${rb.code}). 지금 바로 손으로: npx wrangler rollback ${previous} --message "스모크 실패 수동 롤백"`);
      return 3;
    }
    summary.rolledBack = true;
    summary.result = `롤백 (스모크 FAIL ${fails})`;
    log(`  롤백했어요 — 지금 활성 버전은 ${previous}`);
    return 2;
  };

  let code;
  try {
    code = await steps();
  } catch (e) {
    const stop = e instanceof Stop ? e : new Stop(`예상 못 한 오류: ${e instanceof Error ? e.message : String(e)}`, state.deployed ? 3 : 1);
    log(`\n✗ 멈췄어요: ${stop.message}`);
    code = stop.code;
    summary.result = stop.result ?? (state.deployed ? "확인 필요" : "배포 전 중단");
  }

  // 8. 요약·기록
  summary.elapsedMs = deps.now() - startedAt;
  log("\n== 요약");
  log(`  결과: ${summary.result}`);
  if (summary.commit) log(`  커밋: ${summary.branch}@${summary.commit}`);
  if (summary.previousVersion || summary.newVersion) log(`  버전: ${summary.previousVersion ?? "?"} → ${summary.newVersion ?? "(배포 안 함)"}`);
  if (state.listed) log(`  마이그레이션: ${summary.migrationsApplied.length ? `${summary.migrationsApplied.join(", ")} 적용` : summary.migrationsPending.length ? `${summary.migrationsPending.join(", ")} 남음 (적용 안 함)` : "적용할 것 없음"}`);
  if (summary.hooks.length) log(`  후속 작업: ${summary.hooks.map((h) => `${h.command} → ${h.result}`).join(" / ")}`);
  if (summary.smoke) log(`  스모크: FAIL ${summary.smoke.fails} · WARN ${summary.smoke.warns} (요청 ${summary.smoke.requests}번)`);
  if (summary.previousVersion && !summary.rolledBack && state.deployed) log(`  롤백 대상: ${summary.previousVersion} → npx wrangler rollback ${summary.previousVersion} --message "<이유>"`);
  log(`  걸린 시간: ${formatDuration(summary.elapsedMs)}`);

  if (state.touchedProd && !opts.dryRun) {
    const line = deployLogLine({
      at: startedAt,
      version: state.deployed ? summary.newVersion : null,
      commit: summary.commit,
      migrations: summary.migrationsApplied.length ? summary.migrationsApplied : summary.migrationsPending,
      result: summary.result,
      previous: summary.previousVersion,
    });
    const existing = deps.readFile(DEPLOY_LOG);
    const head = existing === undefined || existing.trim() === "" ? DEPLOY_LOG_HEADER : existing.endsWith("\n") ? "" : "\n";
    try {
      deps.appendFile(DEPLOY_LOG, `${head}${line}\n`);
      log(`  기록: ${DEPLOY_LOG}에 한 줄 더했어요 (커밋은 직접): git add ${DEPLOY_LOG} && git commit -m "docs(deploy): ${kstStamp(startedAt)} 배포 기록"`);
    } catch (e) {
      log(`  ⚠ ${DEPLOY_LOG}에 쓰지 못했어요 (${e instanceof Error ? e.message : e}) — 이 줄을 직접 더하세요:\n${line}`);
    }
  }
  return { code, summary };
}
