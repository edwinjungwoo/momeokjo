import { useCallback, useEffect, useRef, useState } from "react";
import { Mascot, type Pose } from "./Mascot";

const SHOW_MS = 2200;

export type ToastAction = { label: string; onClick: () => void };
type ToastOptions = { action?: ToastAction; ms?: number };
type ToastMsg = { text: string; pose?: Pose; action?: ToastAction; id: number };

export function useToast() {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const timer = useRef<number | undefined>(undefined);
  /** 남은 시간과 타이머를 시작한 시각 (멈췄다 다시 이어가려고) */
  const left = useRef(0);
  const startedAt = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const arm = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    left.current = ms;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => setMsg(null), ms);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setMsg(null);
  }, []);
  const show = useCallback(
    (text: string, pose?: Pose, opts: ToastOptions = {}) => {
      setMsg({ text, pose, action: opts.action, id: Date.now() });
      arm(opts.ms ?? SHOW_MS);
    },
    [arm],
  );
  /** 마우스를 올리거나 포커스가 있는 동안은 사라지지 않는다 */
  const pause = useCallback(() => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    left.current = Math.max(0, left.current - (Date.now() - startedAt.current));
  }, []);
  const resume = useCallback(() => {
    if (timer.current !== undefined) return;
    arm(Math.max(left.current, 1500));
  }, [arm]);
  return { msg, show, hide, pause, resume };
}

/**
 * 아이콘 하나 + 한 줄. 행동이 있으면(되돌리기) 오른쪽에 글자 버튼 하나.
 * 스크린리더: 글과 함께 새로 붙는 알림 영역은 읽히지 않을 수 있어서(VoiceOver) 늘 붙어 있는 sr-only 영역에 글을 쓴다 —
 * 메시지마다 새 줄(key)이라 같은 글이 이어서 와도 다시 읽는다. 보이는 토스트는 알림 영역이 아니다 (두 번 읽지 않게)
 */
export function Toast(props: {
  msg: ToastMsg | null;
  onAction: () => void;
  onPause: () => void;
  onResume: () => void;
}) {
  const { msg, onAction, onPause, onResume } = props;
  // 알림 영역은 메시지가 없어도 같은 자리에 붙어 있다 (구조가 바뀌어 다시 붙지 않게 언제나 같은 조각)
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {msg && <span key={msg.id}>{msg.text}</span>}
      </p>
      {msg && <div
        className={`toast${msg.pose ? " has-pose" : ""}${msg.action ? " has-action" : ""}`}
        key={msg.id}
        onPointerEnter={(e) => e.pointerType === "mouse" && onPause()}
        onPointerLeave={(e) => e.pointerType === "mouse" && onResume()}
        onFocus={onPause}
        onBlur={onResume}
      >
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
      </div>}
    </>
  );
}
