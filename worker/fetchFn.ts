export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class UpstreamError extends Error {
  constructor(
    readonly status: number,
    message = `upstream ${status}`,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
