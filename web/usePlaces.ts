import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RADIUS } from "../shared/constants";
import type { PlacesResponse } from "../shared/types";
import { mergeCachedPlaces } from "../shared/placesCache";
import { fetchPlaces } from "./api";
import { readCachedPlaces, saveCachedPlaces } from "./placesCache";
import { pollDelayMs, shouldPoll } from "./pollSchedule";

const DEBOUNCE_MS = 250;

type State = {
  data: PlacesResponse | null;
  loading: boolean;
  error: boolean;
  polling: boolean;
  /** data가 어느 거점 목록인가 */
  hub: string | null;
  /** data가 기기 저장본이면 저장 시각과 신선도 (새로 받은 목록이면 null) */
  cache: { savedAt: number; fresh: boolean } | null;
};

/**
 * R29: 거점이 바뀌면 250ms 디바운스 후 불러오고,
 * pending(R10 쿨다운·R44 강등 모드로 상세 가져오기가 멈췄으면 제외) 또는 incompleteTiles가 남아 있으면
 * 3초 → 6초 → 12초 간격으로 최대 6번 다시 불러온다 (web/pollSchedule.ts).
 * 다시 불러오는 동안 이전 data를 유지한다 (loading=true로 흐리게만 표시).
 * R42: 반경과 상관없이 거점의 1000m 목록을 한 번 받는다 — 화면 반경은 filterPlaces가 거리로 거른다.
 * R45: 디바운스는 거점을 바꿀 때만 한다. 처음 열 때와 "다시 시도"는 바로 부른다 (첫 목록이 250ms 늦지 않게).
 * R45: 이 거점의 기기 저장본이 있으면 새 목록이 오기 전에 먼저 보여준다 (24시간 안이면 그대로, 넘었으면 흐리게).
 * 새 목록이 오면 바꾸고, 폴링이 끝난 마지막 응답을 다시 저장한다.
 */
export function usePlaces(hubId: string) {
  const [state, setState] = useState<State>({
    data: null, loading: true, error: false, polling: false, hub: null, cache: null,
  });
  const [reloadKey, setReloadKey] = useState(0);
  const lastHub = useRef(hubId);

  useEffect(() => {
    const ctrl = new AbortController();
    let polls = 0;
    let timer: number | undefined;
    let received = false;
    const load = async () => {
      try {
        const { data, text } = await fetchPlaces(hubId, MAX_RADIUS, ctrl.signal);
        if (ctrl.signal.aborted) return;
        received = true;
        const delay = shouldPoll(data) ? pollDelayMs(polls) : null;
        const more = delay !== null;
        setState({ data, loading: false, error: false, polling: more, hub: hubId, cache: null });
        if (delay !== null) {
          polls += 1;
          timer = window.setTimeout(load, delay);
        } else {
          void saveCachedPlaces(hubId, text);
        }
      } catch {
        if (!ctrl.signal.aborted) setState((s) => ({ ...s, loading: false, error: true, polling: false }));
      }
    };
    setState((s) => ({ ...s, loading: true, error: false }));
    // 저장본은 디바운스 없이 바로 읽는다. 이 거점의 새 목록을 이미 들고 있으면(다시 시도) 쓰지 않는다
    void readCachedPlaces(hubId).then((c) => {
      if (!c || received || ctrl.signal.aborted) return;
      let data: PlacesResponse;
      try {
        data = JSON.parse(c.text) as PlacesResponse;
      } catch {
        return;
      }
      setState((s) => mergeCachedPlaces(s, hubId, { data, savedAt: c.savedAt, fresh: c.fresh }));
    });
    const hubChanged = lastHub.current !== hubId;
    lastHub.current = hubId;
    const debounce = window.setTimeout(load, hubChanged ? DEBOUNCE_MS : 0);
    return () => {
      ctrl.abort();
      window.clearTimeout(debounce);
      window.clearTimeout(timer);
    };
  }, [hubId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const { data, loading, error, polling, cache } = state;
  /** 지금 data가 기기 저장본인가 ("stale" = 24시간 넘음 → 자동 뽑기는 새 목록을 기다린다) */
  const fromCache = cache === null ? null : cache.fresh ? "fresh" : "stale";
  return { data, loading, error, polling, fromCache, reload } as const;
}
