import { useCallback, useState } from "react";
import { Mascot } from "./Mascot";

const KEY = "mmj:tip-draw:v1";

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** 첫 방문 안내 말풍선. 첫 뽑기나 ✕로 닫고, 다시 보이지 않게 기억한다 (저장이 안 되면 이번 세션만) */
export function useFirstTip() {
  const [open, setOpen] = useState(() => !seen());
  const dismiss = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* 저장할 수 없는 환경 */
    }
  }, []);
  return { open, dismiss };
}

export function FirstTip({ onClose }: { onClose: () => void }) {
  return (
    <div className="tip" role="note">
      <Mascot pose="conditions" height={56} eager />
      <p className="tip-bubble">
        <span>
          조건을 고르고 <b>🎲 모먹죠?</b>를 눌러보세요!
        </span>
        <button type="button" className="tip-close" aria-label="안내 닫기" onClick={onClose}>
          ×
        </button>
      </p>
    </div>
  );
}
