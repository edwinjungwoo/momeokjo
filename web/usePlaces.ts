import { useCallback, useEffect, useState } from "react";
import { MAX_RADIUS, MIN_RADIUS, RADIUS_STEP } from "../shared/constants";
import type { PlacesResponse } from "../shared/types";
import { fetchPlaces } from "./api";

const DEBOUNCE_MS = 250;
const POLL_MS = 3000;
const MAX_POLLS = 10;

type State = { data: PlacesResponse | null; loading: boolean; error: boolean; polling: boolean };

/**
 * R29: 거점/반경이 바뀌면 250ms 디바운스 후 불러오고,
 * pending 또는 incompleteTiles가 남아 있으면 3초 간격으로 최대 10번 다시 불러온다.
 * 다시 불러오는 동안 이전 data를 유지한다 (loading=true로 흐리게만 표시).
 */
export function usePlaces(hubId: string, rawRadius: number) {
  const [state, setState] = useState<State>({ data: null, loading: true, error: false, polling: false });
  const [reloadKey, setReloadKey] = useState(0);
  // 서버는 50m 단위만 받는다 (응답 캐시 키를 적게) — 혹시 어긋난 값이 와도 맞춘다
  const radius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, Math.round(rawRadius / RADIUS_STEP) * RADIUS_STEP));

  useEffect(() => {
    const ctrl = new AbortController();
    let polls = 0;
    let timer: number | undefined;
    const load = async () => {
      try {
        const data = await fetchPlaces(hubId, radius, ctrl.signal);
        if (ctrl.signal.aborted) return;
        const more = (data.pending > 0 || data.incompleteTiles > 0) && polls < MAX_POLLS;
        setState({ data, loading: false, error: false, polling: more });
        if (more) {
          polls += 1;
          timer = window.setTimeout(load, POLL_MS);
        }
      } catch {
        if (!ctrl.signal.aborted) setState((s) => ({ ...s, loading: false, error: true, polling: false }));
      }
    };
    setState((s) => ({ ...s, loading: true, error: false }));
    const debounce = window.setTimeout(load, DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      window.clearTimeout(debounce);
      window.clearTimeout(timer);
    };
  }, [hubId, radius, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  return { ...state, reload };
}
