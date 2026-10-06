export declare const RATE_LIMIT_WAIT_MS: number;
export declare const RATE_LIMIT_RETRIES: number;
export declare function on429(
  bodyText: string,
  retries: number,
): { action: "retry"; waitMs: number } | { action: "stop"; reason: "rate_limited" | "read_budget" | "write_budget" | "unknown" };
export declare const TRUNCATED_STOP_AFTER: number;
export declare function nextTruncatedStreak(r: { truncated?: boolean; enriched?: number; failed?: number }, streak: number): number;
