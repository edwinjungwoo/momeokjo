import { useCallback, useEffect, useRef, useState } from "react";
import { parseSettings, resolveStart, type Settings } from "../shared/settings";
import { firstTipSeen, readSettingsRaw, writeSettingsRaw } from "./deviceStore";

/**
 * R25: 저장값 → 공유 파라미터 우선 적용. 사용자가 바꾸기 전에는 저장하지 않는다 (공유값이 저장값을 덮지 않게).
 * R43: /{거점 id} 북마크로 열면 그 거점을 저장한다 (공유 링크의 거점 경로는 저장하지 않는다 — R61 거점 선택이 없는 기기만 저장).
 * R61: 첫 접속이면 askHub가 true이고, chooseHub로 고른 거점을 저장한다 (저장값이 있으면 다시 묻지 않는다).
 * localStorage에 못 쓰면 sessionStorage에 남겨 같은 탭 새로고침에서는 다시 묻지 않는다 (web/deviceStore.ts).
 */
export function useSettings() {
  const [init] = useState(() =>
    resolveStart(readSettingsRaw(), window.location.pathname, window.location.search, firstTipSeen()),
  );
  const [settings, setSettings] = useState<Settings>(init.settings);
  const [askHub, setAskHub] = useState(init.askHub);
  const touched = useRef(false);

  // 공유 파라미터는 처음 한 번만 쓴다. 새로고침하면 저장값으로 돌아가도록 주소창에서 지운다 (예전 링크의 lat/lng 포함)
  useEffect(() => {
    if (init.replaceUrl !== null) window.history.replaceState(null, "", init.replaceUrl);
    if (init.saveHub === null) return;
    // 북마크 거점은 저장값의 거점만 바꾼다 (다른 파라미터는 이번에만)
    writeSettingsRaw(JSON.stringify({ ...parseSettings(readSettingsRaw()), hubId: init.saveHub }));
  }, [init]);

  useEffect(() => {
    if (!touched.current) return;
    writeSettingsRaw(JSON.stringify(settings));
  }, [settings]);

  const update = useCallback((fn: (s: Settings) => Settings) => {
    touched.current = true;
    setSettings(fn);
  }, []);

  /**
   * R61: 첫 접속 질문의 답. 같은 거점(기본 거점으로 닫기 포함)이어도 새 객체라서 위 저장 효과가 한 번 쓴다 —
   * 저장값이 생기면 다음부터 묻지 않는다
   */
  const chooseHub = useCallback(
    (hubId: string) => {
      update((s) => ({ ...s, hubId }));
      setAskHub(false);
    },
    [update],
  );

  return { settings, share: init.share, update, askHub, chooseHub };
}
