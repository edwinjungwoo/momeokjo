import { useCallback, useEffect, useRef, useState } from "react";
import { Mascot, type Pose } from "./Mascot";

const SHOW_MS = 2200;

export type ToastAction = { label: string; onClick: () => void };
type ToastOptions = { action?: ToastAction; ms?: number };
type ToastMsg = { text: string; pose?: Pose; action?: ToastAction; id: number };

export function useToast() {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setMsg(null);
  }, []);
  const show = useCallback((text: string, pose?: Pose, opts: ToastOptions = {}) => {
    setMsg({ text, pose, action: opts.action, id: Date.now() });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), opts.ms ?? SHOW_MS);
  }, []);
  return { msg, show, hide };
}

/** 아이콘 하나 + 한 줄. 행동이 있으면(되돌리기) 오른쪽에 글자 버튼 하나 */
export function Toast({ msg, onAction }: { msg: ToastMsg | null; onAction: () => void }) {
  if (!msg) return null;
  const cls = `toast${msg.pose ? " has-pose" : ""}${msg.action ? " has-action" : ""}`;
  return (
    <div className={cls} role="status" aria-live="polite" key={msg.id}>
      {msg.pose && <Mascot pose={msg.pose} height={32} eager />}
      <span>{msg.text}</span>
      {msg.action && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            msg.action!.onClick();
            onAction();
          }}
        >
          {msg.action.label}
        </button>
      )}
    </div>
  );
}
