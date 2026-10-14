import { useSyncExternalStore } from "react";
import { hasCandidateHubs, isCandidateHubId, isPublicHubId, publishedHubIds, setPublishedHubIds } from "../shared/hubs";
import { fetchWithTimeout } from "./api";

/**
 * R68: 화면이 배포 없이 공개 거점을 안다 — GET /api/hubs(공개 거점만)를 읽어 공개된 후보를 shared/hubs.ts에 알린다(setPublishedHubIds).
 * 거점 메뉴·첫 접속 질문·역 검색(pickerHubs), 짧은 링크·공유 링크·설정 검증(isPublicHubId)이 그 목록을 쓴다.
 * 컴파일된 후보(ready: false)가 없으면 공개 거점은 언제나 ready뿐이라 부르지 않는다 (지금 운영 — 요청이 늘지 않는다).
 * 후보가 있으면 페이지를 열 때 한 번(브라우저 60초 캐시 + ETag). 실패(오프라인 등)하면 알던 목록 — 처음이면 ready만.
 * 받은 목록은 기기에 기억해 다음에 열 때 바로 쓴다 (공개된 후보를 고른 사람의 저장 거점이 기본 거점으로 바뀌지 않게) — 카카오 정보가 아니라
 * 우리 거점 id뿐이고, 7일 넘은 것은 버린다
 */
export const PUBLIC_HUBS_KEY = "mmj:public-hubs:v1";
export const PUBLIC_HUBS_CACHE_MAX_AGE_MS = 7 * 86_400_000;
/** 처음 열 때 목록을 기다리는 최대 시간 (needsHubListFirst일 때만) — 넘으면 아는 목록으로 그린다 */
export const HUBS_WAIT_MS = 1500;
const HUBS_TIMEOUT_MS = 5000;

type Store = Pick<Storage, "getItem" | "setItem">;
const local = (): Store | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

let version = 0;
const listeners = new Set<() => void>();
function changed() {
  version += 1;
  for (const l of listeners) l();
}
export const publicHubsVersion = () => version;
export function subscribePublicHubs(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
/** R68: 공개 목록이 바뀌면 다시 그린다 (App이 부른다 — 거점 메뉴·질문은 그릴 때 pickerHubs()를 읽는다) */
export const usePublicHubsVersion = () => useSyncExternalStore(subscribePublicHubs, publicHubsVersion, publicHubsVersion);

const apply = (ids: string[]) => {
  const before = publishedHubIds().join(",");
  setPublishedHubIds(ids);
  if (publishedHubIds().join(",") !== before) changed();
};

/** R68: 공개 거점 id 목록을 바로 쓴다 (관리 화면의 지금 공개·공개 취소 응답) */
export const applyPublicHubIds = (ids: string[]) => apply(ids);

/** /api/hubs 본문 {hubs: [{id, …}]}에서 id만 (모양이 틀리면 null) */
export function parseHubsResponse(json: unknown): string[] | null {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return null;
  const hubs = (json as { hubs?: unknown }).hubs;
  if (!Array.isArray(hubs) || !hubs.every((h) => typeof h === "object" && h !== null && typeof (h as { id?: unknown }).id === "string")) {
    return null;
  }
  return hubs.map((h) => (h as { id: string }).id);
}

/** R68: 기기에 기억한 공개 후보를 바로 쓴다 (시작할 때 한 번, 그리기 전에) */
export function primePublicHubs(store: Store | null = local(), now = Date.now()): void {
  if (!hasCandidateHubs()) return;
  try {
    const v = JSON.parse(store?.getItem(PUBLIC_HUBS_KEY) ?? "null") as { ids?: unknown; at?: unknown } | null;
    if (!v || typeof v.at !== "number" || now - v.at > PUBLIC_HUBS_CACHE_MAX_AGE_MS || !Array.isArray(v.ids)) return;
    apply(v.ids.filter((x): x is string => typeof x === "string"));
  } catch {
    /* 깨진 값은 없는 것으로 */
  }
}

/** R68: /api/hubs를 읽어 공개 목록을 바꾼다. 바꿨으면 true (후보가 없으면 부르지 않고 false, 실패하면 그대로 두고 false) */
export async function loadPublicHubs(
  o: { fetcher?: (url: string, init: RequestInit) => Promise<Response>; store?: Store | null; now?: number } = {},
): Promise<boolean> {
  if (!hasCandidateHubs()) return false;
  const fetcher = o.fetcher ?? ((url: string, init: RequestInit) => fetchWithTimeout(url, init, HUBS_TIMEOUT_MS));
  try {
    const res = await fetcher("/api/hubs", { headers: { accept: "application/json" } });
    if (!res.ok) return false;
    const ids = parseHubsResponse(await res.json());
    if (!ids) return false;
    apply(ids);
    try {
      (o.store === undefined ? local() : o.store)?.setItem(PUBLIC_HUBS_KEY, JSON.stringify({ ids: publishedHubIds(), at: o.now ?? Date.now() }));
    } catch {
      /* 기억하지 못해도 이번에는 쓴다 */
    }
    return true;
  } catch {
    return false;
  }
}

/** 처음 열 때 가리키는 거점 id들: 저장값의 hubId, 경로 /{id}, 예전 공유 링크의 h */
function startupHubIds(stored: string | null, pathname: string, search: string): string[] {
  const out: string[] = [];
  try {
    const v = JSON.parse(stored ?? "null") as { hubId?: unknown } | null;
    if (v && typeof v.hubId === "string") out.push(v.hubId);
  } catch {
    /* 깨진 저장값 */
  }
  const m = /^\/([a-z0-9-]+)\/?$/.exec(pathname);
  if (m) out.push(m[1]);
  const h = new URLSearchParams(search).get("h");
  if (h) out.push(h);
  return out;
}

/**
 * R68: 그리기 전에 목록을 기다려야 하나 — 저장값·짧은 링크·공유 링크가 아직 공개로 모르는 후보를 가리킬 때만 (설정 시작값이 그 거점을
 * 기본 거점으로 바꾸지 않게). 그 밖에는 바로 그리고 목록은 뒤에서 받는다
 */
export function needsHubListFirst(stored: string | null, pathname: string, search: string): boolean {
  return startupHubIds(stored, pathname, search).some((id) => isCandidateHubId(id) && !isPublicHubId(id));
}
