import { useCallback, useEffect, useRef, useState } from "react";

const DURATION_MS = 800;
const FIRST_TICK_MS = 50;
const LAST_TICK_MS = 140;

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * R22: 약 0.8초 동안 후보 이름을 바꿔 보여주다가 done()을 부른다.
 * 간격은 50ms → 140ms로 늘어나서(ease-out) 감속하다 멈추는 느낌을 준다.
 * prefers-reduced-motion이거나 후보가 1개면 바로 done()을 부른다.
 * cancel()은 진행 중인 셔플을 멈추고 done()을 부르지 않는다 (거점·반경을 바꿨을 때).
 */
export function useSlotShuffle() {
  const [display, setDisplay] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const run = useCallback((names: string[], done: () => void) => {
    window.clearTimeout(timer.current);
    if (reducedMotion() || names.length < 2) {
      setDisplay(null);
      setRunning(false);
      done();
      return;
    }
    setRunning(true);
    const start = performance.now();
    let last = -1;
    const tick = () => {
      const t = (performance.now() - start) / DURATION_MS;
      if (t >= 1) {
        setDisplay(null);
        setRunning(false);
        done();
        return;
      }
      let i = Math.floor(Math.random() * names.length);
      if (i === last) i = (i + 1) % names.length;
      last = i;
      setDisplay(names[i]);
      timer.current = window.setTimeout(tick, FIRST_TICK_MS + (LAST_TICK_MS - FIRST_TICK_MS) * t);
    };
    tick();
  }, []);

  const cancel = useCallback(() => {
    window.clearTimeout(timer.current);
    setDisplay(null);
    setRunning(false);
  }, []);

  return { display, running, run, cancel };
}
