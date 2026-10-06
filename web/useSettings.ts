import { useCallback, useEffect, useRef, useState } from "react";
import { parseSettings, resolveStart, type Settings } from "../shared/settings";
import { firstTipSeen } from "./components/FirstTip";

const KEY = "mmj:settings:v1";

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/**
 * R25: 저장값 → 공유 파라미터 우선 적용. 사용자가 바꾸기 전에는 저장하지 않는다 (공유값이 저장값을 덮지 않게).
 * R43: /{거점 id} 북마크로 열면 그 거점을 저장한다 (공유 링크의 거점 경로는 저장하지 않는다 — R61 거점 선택이 없는 기기만 저장).
 * R61: 첫 접속이면 askHub가 true이고, chooseHub로 고른 거점을 바로 저장한다 (저장값이 있으면 다시 묻지 않는다).
 */
export function useSettings() {
  const [init] = useState(() =>
    resolveStart(readStored(), window.location.pathname, window.location.search, firstTipSeen()),
  );
  const [settings, setSettings] = useState<Settings>(init.settings);
  const [askHub, setAskHub] = useState(init.askHub);
  const touched = useRef(false);

  // 공유 파라미터는 처음 한 번만 쓴다. 새로고침하면 저장값으로 돌아가도록 주소창에서 지운다 (예전 링크의 lat/lng 포함)
  useEffect(() => {
    if (init.replaceUrl !== null) window.history.replaceState(null, "", init.replaceUrl);
    if (init.saveHub === null) return;
    // 북마크 거점은 저장값의 거점만 바꾼다 (다른 파라미터는 이번에만)
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...parseSettings(readStored()), hubId: init.saveHub }));
    } catch {
      /* 저장할 수 없는 환경이면 이번 세션만 */
    }
  }, [init]);

  useEffect(() => {
    if (!touched.current) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* 저장할 수 없는 환경이면 이번 세션 값만 쓴다 */
    }
  }, [settings]);

  const update = useCallback((fn: (s: Settings) => Settings) => {
    touched.current = true;
    setSettings(fn);
  }, []);

  /** R61: 첫 접속 질문의 답. 같은 거점(기본 거점으로 닫기 포함)이어도 저장해서 다시 묻지 않는다 */
  const chooseHub = useCallback(
    (hubId: string) => {
      const next = { ...settings, hubId };
      touched.current = true;
      setSettings(next);
      setAskHub(false);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* 저장할 수 없는 환경이면 이번 세션만 (다음에 다시 묻는다) */
      }
    },
    [settings],
  );

  return { settings, share: init.share, update, askHub, chooseHub };
}
