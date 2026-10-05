import { useCallback, useEffect, useRef, useState } from "react";
import { Mascot, type Pose } from "./Mascot";

const SHOW_MS = 2200;

type ToastMsg = { text: string; pose?: Pose; id: number };

export function useToast() {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = useCallback((text: string, pose?: Pose) => {
    setMsg({ text, pose, id: Date.now() });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), SHOW_MS);
  }, []);
  return { msg, show };
}

export function Toast({ msg }: { msg: ToastMsg | null }) {
  if (!msg) return null;
  return (
    <div className={`toast${msg.pose ? " has-pose" : ""}`} role="status" aria-live="polite" key={msg.id}>
      {msg.pose && <Mascot pose={msg.pose} height={32} eager />}
      <span>{msg.text}</span>
    </div>
  );
}
