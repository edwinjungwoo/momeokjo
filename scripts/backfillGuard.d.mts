export declare const SERVER_ERROR_LIMIT: number;
export declare const SERVER_ERROR_WAIT_MS: number;
export declare const BACKFILL_LIMIT_MAX: number;
export declare function on5xx(consecutive: number): { action: "retry"; waitMs: number } | { action: "stop" };
export declare function parseBackfillArgs(
  args: string[],
  hubIds: string[],
): { ok: true; hub: string | undefined; limit: number | undefined } | { ok: false; error: string };
