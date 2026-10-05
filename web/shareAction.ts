export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

/** 터치 기기(폰)에서만 시스템 공유 시트를 쓴다. 데스크톱은 슬랙에 붙여넣기 쉽게 바로 복사한다. */
const prefersSystemShare = () =>
  typeof navigator.share === "function" && (window.matchMedia?.("(pointer: coarse)").matches ?? false);

/**
 * R23: 반드시 클릭 핸들러 안에서 await 없이 바로 호출해야 한다 (navigator.share는 사용자 동작이 필요).
 * 공유 시트를 닫으면(AbortError) 아무것도 하지 않고, 그 밖의 실패는 클립보드 복사로 넘어간다.
 */
export async function shareOrCopy(text: string): Promise<ShareOutcome> {
  if (prefersSystemShare()) {
    try {
      await navigator.share({ title: "모먹죠", text });
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
    }
  }
  return (await copyText(text)) ? "copied" : "failed";
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 권한 거부 등은 아래 방식으로 한 번 더 시도한다 */
  }
  // http(LAN 개발 서버)처럼 Clipboard API가 없는 환경용
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
