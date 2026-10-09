import { useCallback, useEffect, useRef, useState } from "react";
import {
  addFavorite, addSignals, excludePlace, includePlace, isFavorite as isFav, parsePersonal, personalMultiplier, pruneSnapshots,
  refreshSnapshots, removeFavorite, saveSnapshots, undoExclude as undoExcludeState, type PersonalState, type SignalKind,
  type SnapshotSource,
} from "../shared/personal";
import { lastLevel } from "../shared/category";
import { mineSections, unresolvedIds, type LivePlace } from "../shared/mine";
import type { ApiPlace } from "../shared/types";

const KEY = "mmj:personal:v1";

/** 효과가 끝난 신호와 3일 지났거나 아무도 가리키지 않는 이름 기억(R65)을 정리한다 */
const tidy = (s: PersonalState, now: number) => pruneSnapshots(addSignals(s, [], now), now);

function read(): PersonalState {
  try {
    return tidy(parsePersonal(localStorage.getItem(KEY)), Date.now());
  } catch {
    return parsePersonal(null);
  }
}

/** R65: 이름을 기억하는 신호 — 카카오맵 열기·공유 ("최근 열어 본 곳") */
const REMEMBERED: ReadonlySet<SignalKind> = new Set(["kakao_open", "shared"]);

/**
 * R37: 자동 개인화 상태. 이 기기의 localStorage에만 둔다 (읽기·쓰기 실패 시 이번 세션만).
 * 관리 화면은 없고, 카드의 "다음부터 안 보기"와 8초 "되돌리기"만 있다.
 * R65: 같은 저장값에 즐겨찾기와 이름 기억을 더한다 — "내 가게"가 서버 없이 이름을 보여준다.
 */
export function usePersonal() {
  const [state, setState] = useState<PersonalState>(read);
  const touched = useRef(false);

  useEffect(() => {
    if (!touched.current) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* 저장할 수 없는 환경 */
    }
  }, [state]);

  /** 바뀐 것이 없으면 같은 상태 객체가 돌아와 다시 그리지도 저장하지도 않는다 */
  const change = useCallback((fn: (s: PersonalState, now: number) => PersonalState) => {
    touched.current = true;
    setState((s) => {
      const now = Date.now();
      return pruneSnapshots(fn(s, now), now);
    });
  }, []);

  const record = useCallback(
    (kind: SignalKind, places: ApiPlace[]) => {
      if (places.length === 0) return;
      change((s, now) => {
        const next = addSignals(
          s,
          places.map((p) => {
            // R40: 세부 종류(카테고리 마지막 단계)를 같이 남긴다
            const cat = lastLevel(p.category);
            return { id: p.id, group: p.group, kind, at: now, ...(cat ? { cat } : {}) };
          }),
          now,
        );
        return REMEMBERED.has(kind) ? saveSnapshots(next, places, now) : next;
      });
    },
    [change],
  );
  /** R65: 즐겨찾기였으면 즐겨찾기에서도 빠진다 — 되돌리기 전에 favoriteAt으로 빼기 전 값을 받아 둔다 */
  const exclude = useCallback(
    (p: ApiPlace) => change((s, now) => saveSnapshots(excludePlace(s, p.id, now), [p], now)),
    [change],
  );
  /** R37/R65: "되돌리기" — 빼기를 풀고 즐겨찾기였으면 그 시각 그대로 돌려 놓는다 */
  const undoExclude = useCallback(
    (id: string, favoriteAt: number | undefined) => change((s) => undoExcludeState(s, id, favoriteAt)),
    [change],
  );
  const favoriteAt = useCallback(
    (id: string): number | undefined => (Object.hasOwn(state.favorites, id) ? state.favorites[id] : undefined),
    [state],
  );
  /** R65: 목록·단건 응답에 나온 곳의 이름 기억을 새로 한다 (내 가게가 가리키는 곳만, 바뀐 게 없으면 저장하지 않는다) */
  const refresh = useCallback((places: ApiPlace[]) => {
    if (places.length > 0) change((s, now) => refreshSnapshots(s, places, now));
  }, [change]);
  const include = useCallback((id: string) => change((s) => includePlace(s, id)), [change]);
  const isExcluded = useCallback((id: string) => Object.hasOwn(state.excluded, id), [state]);
  /** R65: 즐겨찾기에 넣는다 (뺀 곳이면 풀린다). place가 있으면 이름도 새로 기억한다 */
  const favorite = useCallback(
    (id: string, place?: SnapshotSource) =>
      change((s, now) => {
        const next = addFavorite(s, id, now);
        return place ? saveSnapshots(next, [place], now) : next;
      }),
    [change],
  );
  const unfavorite = useCallback((id: string) => change((s) => removeFavorite(s, id)), [change]);
  const isFavorite = useCallback((id: string) => isFav(state, id), [state]);
  /** R65: "내 가게" 세 묶음 (live = 지금 받아 둔 목록에서 찾기, loading = 이름을 다시 불러오는 중) */
  const mine = useCallback(
    (now: number, live: (id: string) => LivePlace | undefined, loading: (id: string) => boolean) =>
      mineSections(state, now, live, loading),
    [state],
  );
  /** R65: 이름을 다시 불러올 곳 (최대 30곳) */
  const unresolved = useCallback(
    (now: number, live: (id: string) => LivePlace | undefined) => unresolvedIds(state, now, live),
    [state],
  );
  /** 뽑을 때 한 번 읽는다 (now는 뽑는 순간) */
  const multiplier = useCallback(
    (now: number) => (p: ApiPlace) => personalMultiplier(state, p, now),
    [state],
  );

  /** R39: 이 기기에 개인화 신호가 하나라도 있으면 재방문자 */
  const hasSignals = state.signals.length > 0;
  return {
    record, exclude, undoExclude, include, isExcluded, favorite, favoriteAt, unfavorite, isFavorite, refresh, mine, unresolved,
    multiplier, hasSignals,
  };
}
