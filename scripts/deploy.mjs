// 운영 배포 한 번에 (Task 32): npm run release [-- --dry-run] [--yes] [--allow-destructive] [--skip-tests --force]
//   사전 확인 → D1 접근 → 마이그레이션 적용·확인 → 롤백 대상 기록 → 배포 → 후속 작업 → 스모크(실패면 자동 롤백) → 요약·docs/deploys.md
// 판단과 순서는 scripts/release.mjs(테스트 있음), 이 파일은 실제 명령 실행·파일·터미널만 잇는다. 설명은 docs/deploy.md.
// ADMIN_TOKEN은 환경 변수(없으면 .dev.vars)에서 읽어 백필·스모크에 환경 변수로만 넘기고 출력하지 않는다.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { HUBS } from "../shared/hubs.ts";
import { parseReleaseArgs, runRelease } from "./release.mjs";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const parsed = parseReleaseArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}

const readFile = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};
const adminToken = process.env.ADMIN_TOKEN || readFile(".dev.vars")?.match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim() || undefined;

/** 셸 없이 실행한다 (인자에 따옴표·SQL이 있어도 그대로). stdin은 닫아 wrangler가 묻지 않게 한다 */
function run(cmd, args, { env = {}, echo = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b;
      if (echo) process.stdout.write(b);
    });
    child.stderr.on("data", (b) => {
      stderr += b;
      if (echo) process.stderr.write(b);
    });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}\n` }));
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr }));
  });
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes|네|예)$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

const { code } = await runRelease(parsed.opts, {
  run,
  readFile,
  appendFile: (path, text) => appendFileSync(path, text),
  log: (line) => console.log(line),
  confirm,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  adminToken,
  hubIds: HUBS.map((h) => h.id),
});
process.exit(code);
