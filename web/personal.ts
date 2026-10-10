import { useCallback, useEffect, useRef, useState } from "react";
import {
  addFavorite, addSignals, excludePlace, includePlace, isFavorite as isFav, parsePersonal, personalMultiplier, pruneSnapshots,
  refreshSnapshots, removeFavorite, saveSnapshots, tidyPersonal, undoExclude as undoExcludeState, type PersonalState,
  type SignalKind, type SnapshotSource, type Stamp,
} from "../shared/personal";
import { lastLevel } from "../shared/category";
import { mineSections, unresolvedIds, type LivePlace } from "../shared/mine";
import type { ApiPlace } from "../shared/types";

export const PERSONAL_KEY = "mmj:personal:v1";
const KEY = PERSONAL_KEY;

/**
 * 효과가 끝난 신호와 3일 지났거나 아무도 가리키지 않는 이름 기억(R65)을 정리한다. changed면 한 번 다시 저장한다.
 * raw: 읽은 저장본 원문 (latestPersonal이 "그사이 다른 탭이 바꿨나"를 보는 기준 — 못 읽었으면 undefined)
 */
function read(): { state: PersonalState; changed: boolean; raw?: string | null } {
  try {
    const raw = localStorage.getItem(KEY);
    return { ...tidyPersonal(parsePersonal(raw), Date.now()), raw };
  } catch {
    return { state: parsePersonal(null), changed: false };
  }
}

/**
 * Task 56 (여러 탭): 바꾸기 전에 저장본을 다시 읽는다 — 다른 탭이 그사이 바꾼 즐겨찾기·뺀 곳을 이 탭의 옛 상태로 덮어 지우지 않게.
 * 합치지 않고 다른 탭이 바꾼 저장본 위에 이번 조작을 한다 (합치면 다른 탭이 뺀 즐겨찾기가 되살아난다).
 * seen = 이 탭이 마지막으로 읽거나 쓴 저장본 원문. 지금 저장본이 그대로면 이 탭 상태를 그대로 쓴다 — 같은 객체라 바뀐 게 없으면
 * 다시 그리지도 저장하지도 않고, 저장이 실패했던 탭(저장본은 예전 값)은 이 탭에만 있는 값을 지킨다. 읽지 못하면 이 탭 상태(이번 세션만)
 */
export function latestPersonal(
  mine: PersonalState, seen: string | null | undefined, readRaw: () => string | null, now: number,
): PersonalState {
  let raw: string | null;
  try {
    raw = readRaw();
  } catch {
    return mine;
  }
  if (seen === undefined || raw === seen) return mine;
  return tidyPersonal(parsePersonal(raw), now).state;
}

/** Task 56: 다른 탭이 저장한 값(storage 이벤트)으로 바꿀 상태 — 이 키가 아니면 null, clear()(키 null)면 빈 값 */
export function personalFromStorage(key: string | null, newValue: string | null, now: number): PersonalState | null {
  if (key !== null && key !== KEY) return null;
  return tidyPersonal(parsePersonal(newValue), now).state;
}

/** R65: 이름을 기억하는 신호 — 카카오맵 열기·공유 ("최근 열어 본 곳") */
const REMEMBERED: ReadonlySet<SignalKind> = new Set(["kakao_open", "shared"]);

/**
 * R37: 자동 개인화 상태. 이 기기의 localStorage에만 둔다 (읽기·쓰기 실패 시 이번 세션만).
 * 관리 화면은 없고, 카드의 "다음부터 안 보기"와 8초 "되돌리기"만 있다.
 * R65: 같은 저장값에 즐겨찾기와 이름 기억을 더한다 — "내 가게"가 서버 없이 이름을 보여준다.
 */
export function usePersonal() {
  const [initial] = useState(read);
  const [state, setState] = useState<PersonalState>(initial.state);
  /** 지금 상태 (같은 이벤트 안에서 이어지는 change가 앞의 결과 위에 하도록 렌더를 기다리지 않는다) */
  const current = useRef(initial.state);
  /** 이 탭이 마지막으로 읽거나 쓴 저장본 원문 (latestPersonal — 못 읽은 환경이면 undefined) */
  const seen = useRef<string | null | undefined>(initial.raw);

  const save = useCallback((s: PersonalState) => {
    try {
      const json = JSON.stringify(s);
      localStorage.setItem(KEY, json);
      seen.current = json;
    } catch {
      /* 저장할 수 없는 환경 — 이번 세션만 (seen은 그대로라 다음 change도 이 탭 상태 위에 한다) */
    }
  }, []);

  // R65: 읽을 때 지난 이름 기억을 버렸으면 정리한 값을 바로 한 번 저장한다
  useEffect(() => {
    if (initial.changed) save(initial.state);
  }, [initial, save]);

  // Task 56: 다른 탭이 저장하면 이 탭 상태도 바꾼다 (♡·내 가게·뽑기가 다른 탭에서 바꾼 대로). 그 탭이 이미 썼으니 다시 쓰지 않는다
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      const next = personalFromStorage(e.key, e.newValue, Date.now());
      if (!next) return;
      seen.current = e.newValue;
      current.current = next;
      setState(next);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  /**
   * 바뀐 것이 없으면 같은 상태 객체가 돌아와 다시 그리지도 저장하지도 않는다. 바꾸면 바로 저장한다.
   * Task 56: 바꾸기 전에 저장본을 다시 읽어 다른 탭이 그사이 바꾼 값 위에 한다 (latestPersonal)
   */
  const change = useCallback((fn: (s: PersonalState, now: number) => PersonalState) => {
    const now = Date.now();
    const prev = current.current;
    const next = pruneSnapshots(fn(latestPersonal(prev, seen.current, () => localStorage.getItem(KEY), now), now), now);
    if (next === prev) return;
    current.current = next;
    save(next);
    setState(next);
  }, [save]);

  /** stamp: 그 가게 정보를 받은 때 (기기 저장본에서 온 것이면 저장 시각 — R65 이름 기억 시각) */
  const record = useCallback(
    (kind: SignalKind, places: ApiPlace[], stamp?: Stamp) => {
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
        return REMEMBERED.has(kind) ? saveSnapshots(next, places, now, stamp) : next;
      });
    },
    [change],
  );
  /** R65: 즐겨찾기였으면 즐겨찾기에서도 빠진다 — 되돌리기 전에 favoriteAt으로 빼기 전 값을 받아 둔다 */
  const exclude = useCallback(
    (p: ApiPlace, stamp?: Stamp) => change((s, now) => saveSnapshots(excludePlace(s, p.id, now), [p], now, stamp)),
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
  const refresh = useCallback((places: ApiPlace[], stamp?: Stamp) => {
    if (places.length > 0) change((s, now) => refreshSnapshots(s, places, now, stamp));
  }, [change]);
  const include = useCallback((id: string) => change((s) => includePlace(s, id)), [change]);
  const isExcluded = useCallback((id: string) => Object.hasOwn(state.excluded, id), [state]);
  /** R65: 즐겨찾기에 넣는다 (뺀 곳이면 풀린다). place가 있으면 이름도 새로 기억한다 */
  const favorite = useCallback(
    (id: string, place?: SnapshotSource, stamp?: Stamp) =>
      change((s, now) => {
        const next = addFavorite(s, id, now);
        return place ? saveSnapshots(next, [place], now, stamp) : next;
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
  /** R65: 이름을 다시 불러올 곳 (최대 30곳, skip = 이번 세션에 못 찾은 곳) */
  const unresolved = useCallback(
    (now: number, live: (id: string) => LivePlace | undefined, skip: (id: string) => boolean) =>
      unresolvedIds(state, now, live, skip),
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
