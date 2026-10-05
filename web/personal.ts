import { useCallback, useEffect, useRef, useState } from "react";
import {
  addSignals, excludePlace, includePlace, parsePersonal, personalMultiplier, type PersonalState, type SignalKind,
} from "../shared/personal";
import { lastLevel } from "../shared/category";
import type { ApiPlace } from "../shared/types";

const KEY = "mmj:personal:v1";

function read(): PersonalState {
  try {
    return addSignals(parsePersonal(localStorage.getItem(KEY)), [], Date.now());
  } catch {
    return parsePersonal(null);
  }
}

/**
 * R37: 자동 개인화 상태. 이 기기의 localStorage에만 둔다 (읽기·쓰기 실패 시 이번 세션만).
 * 관리 화면은 없고, 카드의 "여긴 빼줘"와 5초 "되돌리기"만 있다.
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

  const change = useCallback((fn: (s: PersonalState) => PersonalState) => {
    touched.current = true;
    setState(fn);
  }, []);

  const record = useCallback(
    (kind: SignalKind, places: ApiPlace[]) => {
      if (places.length === 0) return;
      const now = Date.now();
      change((s) =>
        addSignals(
          s,
          places.map((p) => {
            // R40: 세부 종류(카테고리 마지막 단계)를 같이 남긴다
            const cat = lastLevel(p.category);
            return { id: p.id, group: p.group, kind, at: now, ...(cat ? { cat } : {}) };
          }),
          now,
        ),
      );
    },
    [change],
  );
  const exclude = useCallback((id: string) => change((s) => excludePlace(s, id, Date.now())), [change]);
  const include = useCallback((id: string) => change((s) => includePlace(s, id)), [change]);
  const isExcluded = useCallback((id: string) => Object.hasOwn(state.excluded, id), [state]);
  /** 뽑을 때 한 번 읽는다 (now는 뽑는 순간) */
  const multiplier = useCallback(
    (now: number) => (p: ApiPlace) => personalMultiplier(state, p, now),
    [state],
  );

  return { record, exclude, include, isExcluded, multiplier };
}
