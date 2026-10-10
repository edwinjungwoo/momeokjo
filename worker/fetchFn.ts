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

/**
 * 카카오 호출 하나(헤더·본문)를 기다리는 최대 시간. 403·429 대신 응답을 붙잡아 두는 차단(tarpit)이나 죽은 연결에
 * 실행이 플랫폼 한도까지 매달리지 않게 끊는다 — 끊긴 호출은 네트워크 실패(재시도·network)와 같다 (상세는 50~95KB, 보통 1초 안)
 */
export const UPSTREAM_TIMEOUT_MS = 10_000;

/** 읽지 않을 응답 본문은 버린다 — 연결을 붙잡지 않게 (동시 연결 6개) */
export const discardBody = (res: Response): void => {
  res.body?.cancel().catch(() => {});
};

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
