import { useCallback, useEffect, useRef, useState } from "react";

const SHOW_MS = 2200;

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), SHOW_MS);
  }, []);
  return { msg, show };
}

export function Toast({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div className="toast" role="status" aria-live="polite" key={msg}>
      {msg}
    </div>
  );
}
