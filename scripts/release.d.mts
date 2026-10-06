import type { MIGRATION_CHECKS } from "./migrationChecks.mjs";

export type ReleaseOpts = {
  dryRun: boolean;
  skipTests: boolean;
  force: boolean;
  yes: boolean;
  allowDestructive: boolean;
  /** 배포 전 기준 스모크에 FAIL이 있어도 진행 — 이 플래그로만 (--yes는 받아들이지 않음) */
  acceptBaselineFails: boolean;
};
export type RunResult = { code: number; stdout?: string; stderr?: string };
export type RunOptions = { env?: Record<string, string>; echo?: boolean };
export type ReleaseDeps = {
  /** 명령 하나를 셸 없이 실행한다. echo면 출력을 그대로 보여주면서 모은다. env는 process.env 위에 더한다 */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  /** 없으면 undefined */
  readFile(path: string): string | undefined;
  appendFile(path: string, text: string): void;
  /** 덮어쓴다 (필요하면 폴더도 만든다) — PENDING_HOOKS_FILE에만 쓴다 */
  writeFile(path: string, text: string): void;
  log(line: string): void;
  confirm(question: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  isTTY: boolean;
  /** 백필·스모크 감사에 넘길 관리자 토큰 (출력하지 않는다) */
  adminToken: string | undefined;
  hubIds: string[];
};
export type SmokeSummary = { requests: number; fails: number; warns: number };
export type HookResult = { migration: string; name: string; command: string; result: "ok" | "budget" | "failed" };
export type ReleaseSummary = {
  dryRun: boolean;
  branch: string | null;
  commit: string | null;
  previousVersion: string | null;
  newVersion: string | null;
  migrationsPending: string[];
  migrationsApplied: string[];
  hooks: HookResult[];
  /** 배포 전 기준 스모크의 FAIL 줄 */
  smokeBaseline: string[] | null;
  /** 배포 뒤 스모크 (newFails: 기준에 없던 FAIL 중 판단에 쓴 것) */
  smoke: (SmokeSummary & { newFails: string[] }) | null;
  rolledBack: boolean;
  result: string;
  elapsedMs: number;
};
export type PlannedHook = { migration: string; name: string; cmd: string; args: string[]; needsAdminToken: boolean };

export declare const DB_NAME: string;
export declare const PROD_URL: string;
export declare const RELEASE_BRANCHES: string[];
export declare const REQUIRED_SECRETS: string[];
export declare const DEPLOY_LOG: string;
export declare const DIRTY_IGNORED: string[];
export declare const SMOKE_SETTLE_MS: number;
export declare const DEPLOY_LOG_HEADER: string;
export declare const PENDING_HOOKS_FILE: string;
export declare const UNKNOWN_VERSION_RESULT: string;
export declare const DATA_STATE_RESULT: string;
export declare const RECHECK_MS: number;

export declare function parseReleaseArgs(argv: string[]): { ok: true; opts: ReleaseOpts } | { ok: false; error: string };
export declare function stripAnsi(s: string): string;
export declare function parsePendingMigrations(text: string): string[] | null;
export declare function isDestructive(sql: string): string[];
export declare function parseD1Rows(text: string): Array<Record<string, unknown>> | null;
export declare function isD1LimitError(text: string): boolean;
export declare function parseSecretNames(text: string): string[] | null;
export declare function parseDeployVersionId(text: string): string | null;
export declare function parseActiveVersion(text: string): { ok: true; id: string } | { ok: false; error: string };
export declare function parseSmokeSummary(text: string): SmokeSummary | null;
export declare function parseSmokeFails(text: string): string[];
export declare function smokeFailKey(line: string): string;
export declare function isDataStateFail(line: string): boolean;
export declare function classifySmokeFails(fails: string[], hubIds: string[]): { code: string[]; data: string[] };
export type RollbackVerdict = { action: "keep" | "rollback" | "data" | "manual"; reason: string; newFails: string[] };
export declare function shouldRollback(smoke: {
  code: number;
  summary: SmokeSummary | null;
  fails?: string[];
  baseline?: string[];
  hubIds?: string[];
}): RollbackVerdict;
export declare function confirmRollback(input: {
  first: string[];
  rerun: { code: number; summary: SmokeSummary | null; fails: string[] };
  baseline: string[];
  hubIds: string[];
}): RollbackVerdict;
export declare function parsePendingHooks(text: string | undefined): { hooks: PlannedHook[]; corrupt: boolean };
export declare function dirtyPaths(porcelain: string): string[];
export declare function planRelease(input: {
  pending: string[];
  sqlByName: Record<string, string | undefined>;
  allowDestructive: boolean;
  hubIds: string[];
  hasAdminToken: boolean;
  carriedHooks?: PlannedHook[];
  checks?: typeof MIGRATION_CHECKS;
}): { ok: boolean; errors: string[]; migrations: string[]; hooks: PlannedHook[]; lines: string[] };
export declare function kstStamp(ms: number): string;
export declare function formatDuration(ms: number): string;
export declare function deployLogLine(entry: {
  at: number;
  version: string | null;
  commit: string | null;
  migrations: string[];
  /** 마이그레이션 칸 뒤에 괄호로 (예: "적용 실패") */
  migrationsNote?: string;
  result: string;
  previous: string | null;
}): string;
export declare function runRelease(opts: ReleaseOpts, deps: ReleaseDeps): Promise<{ code: number; summary: ReleaseSummary }>;
