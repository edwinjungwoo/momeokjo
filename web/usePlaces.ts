import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RADIUS } from "../shared/constants";
import type { PlacesResponse } from "../shared/types";
import { mergeCachedPlaces, placesDataAt } from "../shared/placesCache";
import { loadPlaces } from "./api";
import { readCachedEtag, readCachedPlaces, saveCachedPlaces } from "./placesCache";
import { loadDelayMs, pollDelayMs, shouldPoll } from "./pollSchedule";

type State = {
  data: PlacesResponse | null;
  loading: boolean;
  error: boolean;
  polling: boolean;
  /** data가 어느 거점 목록인가 */
  hub: string | null;
  /** data가 기기 저장본이면 저장 시각과 신선도 (새로 받은 목록이면 null) */
  cache: { savedAt: number; fresh: boolean } | null;
  /** R65: 네트워크로 data를 받은 시각 (304로 확인한 저장본 포함) */
  receivedAt: number | null;
};

/**
 * R29: 거점이 바뀌면 250ms 디바운스 후 불러오고,
 * pending(R10 쿨다운·R44 강등 모드로 상세 가져오기가 멈췄으면 제외) 또는 incompleteTiles가 남아 있으면
 * 10초 → 12초 → 15초 간격으로 최대 5번 다시 불러온다 (web/pollSchedule.ts — 첫 폴링은 10초 엣지 캐시 뒤).
 * 다시 불러오는 동안 이전 data를 유지한다 (loading=true로 흐리게만 표시).
 * R42: 반경과 상관없이 거점의 1000m 목록을 한 번 받는다 — 화면 반경은 filterPlaces가 거리로 거른다.
 * R45: 디바운스는 거점을 바꿀 때만 한다. 처음 열 때와 "다시 시도"는 바로 부른다 (첫 목록이 250ms 늦지 않게).
 * R45: 이 거점의 기기 저장본이 있으면 새 목록이 오기 전에 먼저 보여준다 (24시간 안이면 그대로, 넘었으면 흐리게).
 * 새 목록이 오면 바꾸고, 폴링이 끝난 마지막 응답을 다시 저장한다.
 * R61: enabled가 false(첫 접속 거점 질문이 떠 있음)면 아무것도 부르지 않는다 — 고르기 전 기본 거점 목록을 헛되이 받지 않게.
 * 켜지면 그 거점을 디바운스 없이 바로 부른다.
 * R56: 첫 요청은 저장본의 ETag(작은 키, 동기)를 If-None-Match로 바로 보낸다 — 저장본 해석을 기다리지 않는다.
 * 서버 스냅샷이 같으면 304(본문 없음)라 저장본을 새 목록으로 쓴다 (web/api.ts loadPlaces).
 */
export function usePlaces(hubId: string, enabled = true) {
  const [state, setState] = useState<State>({
    data: null, loading: true, error: false, polling: false, hub: null, cache: null, receivedAt: null,
  });
  const [reloadKey, setReloadKey] = useState(0);
  /** 마지막으로 불러온 거점 (아직 안 불렀으면 null — 첫 요청은 디바운스하지 않는다) */
  const lastHub = useRef<string | null>(null);

  useEffect(() => {
    const delay0 = loadDelayMs(lastHub.current, hubId, enabled);
    if (delay0 === null) return;
    const ctrl = new AbortController();
    let polls = 0;
    let timer: number | undefined;
    let received = false;
    // 저장본은 디바운스 없이 바로 읽고 한 번만 해석한다 (먼저 보여주기와 304일 때 같이 쓴다)
    const cached = readCachedPlaces(hubId).then((c) => {
      if (!c) return null;
      try {
        return { ...c, data: JSON.parse(c.text) as PlacesResponse };
      } catch {
        return null;
      }
    });
    // 첫 요청만 ETag를 보낸다 (폴링은 pending이 줄었는지 보려는 것이라 본문을 받는다)
    let etagForFirst: string | null = readCachedEtag(hubId);
    const load = async () => {
      try {
        const sent = etagForFirst;
        etagForFirst = null;
        const { data, text, etag } = await loadPlaces(hubId, MAX_RADIUS, ctrl.signal, sent, () => cached);
        if (ctrl.signal.aborted) return;
        received = true;
        const delay = shouldPoll(data) ? pollDelayMs(polls) : null;
        const more = delay !== null;
        setState({ data, loading: false, error: false, polling: more, hub: hubId, cache: null, receivedAt: Date.now() });
        if (delay !== null) {
          polls += 1;
          timer = window.setTimeout(load, delay);
        } else {
          void saveCachedPlaces(hubId, text, etag);
        }
      } catch {
        if (!ctrl.signal.aborted) setState((s) => ({ ...s, loading: false, error: true, polling: false }));
      }
    };
    setState((s) => ({ ...s, loading: true, error: false }));
    // 이 거점의 새 목록을 이미 들고 있으면(다시 시도) 저장본은 쓰지 않는다
    void cached.then((c) => {
      if (!c || received || ctrl.signal.aborted) return;
      setState((s) => mergeCachedPlaces(s, hubId, { data: c.data, savedAt: c.savedAt, fresh: c.fresh }));
    });
    lastHub.current = hubId;
    const debounce = window.setTimeout(load, delay0);
    return () => {
      ctrl.abort();
      window.clearTimeout(debounce);
      window.clearTimeout(timer);
    };
  }, [hubId, reloadKey, enabled]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const { data, loading, error, polling, cache } = state;
  /** 지금 data가 기기 저장본인가 ("stale" = 24시간 넘음 → 자동 뽑기는 새 목록을 기다린다) */
  const fromCache = cache === null ? null : cache.fresh ? "fresh" : "stale";
  /** R65: 지금 data를 받은 때 (기기 저장본이면 저장 시각) — 이름 기억 시각 */
  const dataAt = placesDataAt(cache, state.receivedAt);
  return { data, loading, error, polling, fromCache, dataAt, reload } as const;
}
