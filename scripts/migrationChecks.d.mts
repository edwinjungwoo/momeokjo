export type MigrationCheck = { what: string; sql: string; expect: string[] };
export type HookCommand = { cmd: string; args: string[] };
export type MigrationHook = { name: string; needsAdminToken: boolean; commands: (hubIds: string[]) => HookCommand[] };
export declare const BACKFILL_HOOK_LIMIT: number;
export declare const MIGRATION_CHECKS: Record<string, { checks: MigrationCheck[]; hooks?: MigrationHook[] }>;
export declare function objectState(rows: Array<Record<string, unknown>>, expect: string[]): "all" | "partial" | "none";
