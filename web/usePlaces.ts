import { useCallback, useEffect, useState } from "react";
import type { LatLng, PlacesResponse } from "../shared/types";
import { fetchPlaces } from "./api";

const DEBOUNCE_MS = 250;
const POLL_MS = 3000;
const MAX_POLLS = 10;

type State = { data: PlacesResponse | null; loading: boolean; error: boolean; polling: boolean };

/**
 * R29: 기준점/반경이 바뀌면 250ms 디바운스 후 불러오고,
 * pending 또는 incompleteTiles가 남아 있으면 3초 간격으로 최대 10번 다시 불러온다.
 * 다시 불러오는 동안 이전 data를 유지한다 (loading=true로 흐리게만 표시).
 */
export function usePlaces(center: LatLng, radius: number) {
  const [state, setState] = useState<State>({ data: null, loading: true, error: false, polling: false });
  const [reloadKey, setReloadKey] = useState(0);
  const { lat, lng } = center;

  useEffect(() => {
    const ctrl = new AbortController();
    let polls = 0;
    let timer: number | undefined;
    const load = async () => {
      try {
        const data = await fetchPlaces({ lat, lng }, radius, ctrl.signal);
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
  }, [lat, lng, radius, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  return { ...state, reload };
}
