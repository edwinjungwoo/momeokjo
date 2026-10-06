import type { MIGRATION_CHECKS } from "./migrationChecks.mjs";

export type ReleaseOpts = { dryRun: boolean; skipTests: boolean; force: boolean; yes: boolean; allowDestructive: boolean };
export type RunResult = { code: number; stdout?: string; stderr?: string };
export type RunOptions = { env?: Record<string, string>; echo?: boolean };
export type ReleaseDeps = {
  /** 명령 하나를 셸 없이 실행한다. echo면 출력을 그대로 보여주면서 모은다. env는 process.env 위에 더한다 */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  /** 없으면 undefined */
  readFile(path: string): string | undefined;
  appendFile(path: string, text: string): void;
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
  smoke: SmokeSummary | null;
  rolledBack: boolean;
  result: string;
  elapsedMs: number;
};
export type PlannedHook = { migration: string; name: string; cmd: string; args: string[] };

export declare const DB_NAME: string;
export declare const PROD_URL: string;
export declare const RELEASE_BRANCHES: string[];
export declare const REQUIRED_SECRETS: string[];
export declare const DEPLOY_LOG: string;
export declare const DIRTY_IGNORED: string[];
export declare const SMOKE_SETTLE_MS: number;
export declare const DEPLOY_LOG_HEADER: string;

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
export declare function shouldRollback(smoke: { code: number; summary: SmokeSummary | null }): {
  action: "keep" | "rollback" | "manual";
  reason: string;
};
export declare function dirtyPaths(porcelain: string): string[];
export declare function planRelease(input: {
  pending: string[];
  sqlByName: Record<string, string | undefined>;
  allowDestructive: boolean;
  hubIds: string[];
  hasAdminToken: boolean;
  checks?: typeof MIGRATION_CHECKS;
}): { ok: boolean; errors: string[]; migrations: string[]; hooks: PlannedHook[]; lines: string[] };
export declare function kstStamp(ms: number): string;
export declare function formatDuration(ms: number): string;
export declare function deployLogLine(entry: {
  at: number;
  version: string | null;
  commit: string | null;
  migrations: string[];
  result: string;
  previous: string | null;
}): string;
export declare function runRelease(opts: ReleaseOpts, deps: ReleaseDeps): Promise<{ code: number; summary: ReleaseSummary }>;
