import type { PlaceDetail, PlaceSummary } from "../shared/types";
import type { Budget } from "./budget";
import { parseDetail } from "./detailParser";
import { UPSTREAM_TIMEOUT_MS, discardBody, sleep as realSleep, type FetchFn } from "./fetchFn";

export const PLACE_DETAIL_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
  pf: "PC",
  Accept: "application/json",
  Origin: "https://place.map.kakao.com",
  Referer: "https://place.map.kakao.com/",
};

const RETRY_DELAYS = [250, 1000];

export type PlaceFetchResult =
  | { ok: true; summary: PlaceSummary; detail: PlaceDetail }
  | { ok: false; reason: string };

/**
 * onBody: 정상 응답 본문을 읽었을 때 그 글자 수 (Task 34 — 상세 보충의 CPU는 대부분 본문 JSON을 푸는 데 쓰여서,
 * 보충은 이 값을 모아 한 번에 풀 글자 수를 제한한다). 본문은 text()로 읽어 JSON.parse한다 — res.json()과 결과가 같다(테스트).
 * 시도마다 timeoutMs(기본 UPSTREAM_TIMEOUT_MS)가 지나면 끊는다 — 응답 전이면 네트워크 실패처럼 재시도, 본문을 받다 끊기면 network.
 * 성공이 아닌 응답의 본문은 읽지 않고 버린다
 */
export async function fetchPlaceDetail(
  fetcher: FetchFn,
  id: string,
  opts: { budget: Budget; sleep?: (ms: number) => Promise<void>; onBody?: (chars: number) => void; timeoutMs?: number },
): Promise<PlaceFetchResult> {
  const wait = opts.sleep ?? realSleep;
  const url = `https://place-api.map.kakao.com/places/panel3/${encodeURIComponent(id)}`;
  for (let attempt = 0; ; attempt++) {
    if (!opts.budget.take()) return { ok: false, reason: "budget" };
    let res: Response | null;
    try {
      res = await fetcher(url, { headers: PLACE_DETAIL_HEADERS, signal: AbortSignal.timeout(opts.timeoutMs ?? UPSTREAM_TIMEOUT_MS) });
    } catch {
      res = null;
    }
    if (res && res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch {
        // 본문을 받다 끊겼다 (시간 초과 포함) — 응답 형식 문제가 아니다
        return { ok: false, reason: "network" };
      }
      opts.onBody?.(text.length);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, reason: "schema" };
      }
      const parsed = parseDetail(json);
      return parsed.ok ? parsed : { ok: false, reason: parsed.reason };
    }
    if (res) discardBody(res);
    if (res && res.status < 500) return { ok: false, reason: `http_${res.status}` };
    if (attempt >= RETRY_DELAYS.length) return { ok: false, reason: res ? `http_${res.status}` : "network" };
    await wait(RETRY_DELAYS[attempt]);
  }
}
