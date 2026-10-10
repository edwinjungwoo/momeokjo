import type { ApiPlace, PlacesResponse } from "../shared/types";

/** 응답(헤더)이 이만큼 안 오면 끊는다 — 막힌 연결(사내 Wi-Fi 로그인 화면, 끊긴 LTE)에서 "찾고 있어요"·"메뉴를 불러오는 중"이 끝없이 돌지 않게 */
export const RESPONSE_TIMEOUT_MS = 15_000;

/** 응답 상태가 실패인 요청 (status로 없음(404)과 일시 실패를 가린다) */
export class HttpError extends Error {
  constructor(readonly status: number, what: string) {
    super(`${what} ${status}`);
    this.name = "HttpError";
  }
}
/** R65: 서버가 "없음"이라고 답했다 (오프라인·429·5xx·시간 초과는 아니다 — 다음에 다시 부른다) */
export const isNotFound = (e: unknown): boolean => e instanceof HttpError && e.status === 404;

/**
 * fetch + 응답(헤더) 시간 초과 (timeoutMs). 부른 쪽 signal로도 멈춘다 — AbortSignal.any 없이(오래된 iOS Safari).
 * 응답이 오면 시간 초과는 풀린다 (느린 연결에서 본문을 받는 중에는 끊지 않는다). 시간 초과는 TimeoutError로 실패
 */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = RESPONSE_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const outer = init.signal;
  if (outer?.aborted) ctrl.abort(outer.reason);
  else outer?.addEventListener("abort", () => ctrl.abort(outer.reason), { once: true });
  const timer = setTimeout(() => ctrl.abort(new DOMException("응답이 오지 않아요", "TimeoutError")), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type PlacesFetch =
  | { notModified: true }
  | { notModified: false; data: PlacesResponse; text: string; etag: string | null };

/**
 * R12: 거점 id + 50m 단위 반경 (화면은 R42로 항상 1000m). R45: 기기에 저장하려고 원문(text)도 준다.
 * R56: 기기 저장본의 ETag(etag)를 주면 If-None-Match로 보낸다 — 서버 스냅샷이 같으면 304(본문 없음)이라 notModified.
 * 응답의 ETag를 돌려준다 (스냅샷이 아닌 응답은 null).
 */
export async function fetchPlaces(
  hubId: string, radius: number, signal?: AbortSignal, etag?: string | null,
): Promise<PlacesFetch> {
  const q = new URLSearchParams({ hub: hubId, radius: String(radius) });
  const res = await fetchWithTimeout(`/api/places?${q}`, { signal, ...(etag ? { headers: { "if-none-match": etag } } : {}) });
  if (res.status === 304 && etag) return { notModified: true };
  if (!res.ok) throw new HttpError(res.status, "places");
  const text = await res.text();
  return { notModified: false, data: JSON.parse(text) as PlacesResponse, text, etag: res.headers.get("etag") };
}

export type PlacesLoaded = { data: PlacesResponse; text: string; etag: string | null; fromCopy: boolean };
type DeviceCopy = { data: PlacesResponse; text: string; etag?: string } | null;

/**
 * R56 다시 열 때: 기기 저장본의 ETag(작은 키에서 바로 읽은 값)로 곧바로 요청한다 — 저장본(~1MB)을 읽고 해석하기를 기다리지 않는다.
 * 304면 그때 저장본을 받아(copy) ETag가 같은지 보고 새 목록으로 쓴다(fromCopy). 저장본이 없거나 ETag가 다르면 조건 없이 다시 받는다
 */
export async function loadPlaces(
  hubId: string, radius: number, signal: AbortSignal | undefined, etag: string | null, copy: () => Promise<DeviceCopy>,
): Promise<PlacesLoaded> {
  const r = await fetchPlaces(hubId, radius, signal, etag);
  if (!r.notModified) return { data: r.data, text: r.text, etag: r.etag, fromCopy: false };
  const c = await copy();
  if (c && c.etag === etag) return { data: c.data, text: c.text, etag, fromCopy: true };
  const again = await fetchPlaces(hubId, radius, signal, null);
  if (again.notModified) throw new Error("places 304 without If-None-Match");
  return { data: again.data, text: again.text, etag: again.etag, fromCopy: false };
}

/** R13: 단일 가게. distance/walkMinutes가 없고 detail이 null일 수 있다 */
export async function fetchPlace(id: string, signal?: AbortSignal): Promise<ApiPlace> {
  const res = await fetchWithTimeout(`/api/places/${encodeURIComponent(id)}`, { signal });
  if (!res.ok) throw new HttpError(res.status, "place");
  return res.json();
}
