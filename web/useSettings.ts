import { useCallback, useEffect, useRef, useState } from "react";
import { applyShareParams, parseSettings, type Settings } from "../shared/settings";
import { parseShareParams } from "../shared/share";

const KEY = "mmj:settings:v1";

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

/** R25: 저장값 → 공유 파라미터 우선 적용. 사용자가 바꾸기 전에는 저장하지 않는다 (공유값이 저장값을 덮지 않게) */
export function useSettings() {
  const [init] = useState(() => {
    const share = parseShareParams(window.location.search);
    return { share, settings: applyShareParams(parseSettings(readStored()), share) };
  });
  const [settings, setSettings] = useState<Settings>(init.settings);
  const touched = useRef(false);

  // 공유 파라미터는 처음 한 번만 쓴다. 새로고침하면 저장값으로 돌아가도록 주소창에서 지운다 (예전 링크의 lat/lng 포함)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (["t", "p", "h", "r", "lat", "lng"].some((k) => q.has(k))) window.history.replaceState(null, "", window.location.pathname);
  }, []);

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

  return { settings, share: init.share, update };
}
