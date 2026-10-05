import { useCallback, useEffect, useState } from "react";
import { MAX_RADIUS } from "../shared/constants";
import type { PlacesResponse } from "../shared/types";
import { fetchPlaces } from "./api";

const DEBOUNCE_MS = 250;
const POLL_MS = 3000;
const MAX_POLLS = 10;

type State = { data: PlacesResponse | null; loading: boolean; error: boolean; polling: boolean };

/**
 * R29: 거점이 바뀌면 250ms 디바운스 후 불러오고,
 * pending(R44 강등 모드면 제외) 또는 incompleteTiles가 남아 있으면 3초 간격으로 최대 10번 다시 불러온다.
 * 다시 불러오는 동안 이전 data를 유지한다 (loading=true로 흐리게만 표시).
 * R42: 반경과 상관없이 거점의 1000m 목록을 한 번 받는다 — 화면 반경은 filterPlaces가 거리로 거른다.
 */
export function usePlaces(hubId: string) {
  const [state, setState] = useState<State>({ data: null, loading: true, error: false, polling: false });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let polls = 0;
    let timer: number | undefined;
    const load = async () => {
      try {
        const data = await fetchPlaces(hubId, MAX_RADIUS, ctrl.signal);
        if (ctrl.signal.aborted) return;
        // R44: 강등 모드면 pending이 줄지 않으므로 그것 때문에 다시 부르지 않는다
        const waitDetails = data.pending > 0 && (data.detailsFrozenSince ?? null) === null;
        const more = (waitDetails || data.incompleteTiles > 0) && polls < MAX_POLLS;
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
  }, [hubId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  return { ...state, reload };
}
