import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Toast } from "../../web/components/Toast";

const noop = () => {};
const html = (msg: { text: string; id: number } | null) =>
  renderToStaticMarkup(createElement(Toast, { msg, onAction: noop, onPause: noop, onResume: noop }));

describe("R29 토스트 알림 (스크린리더)", () => {
  it("R29: 토스트 글은 늘 붙어 있는 sr-only 알림 영역(role=status, aria-live=polite)에 쓴다 — 글과 함께 새로 붙는 영역은 읽히지 않을 수 있다(VoiceOver)", () => {
    expect(html(null)).toBe('<p class="sr-only" role="status" aria-live="polite"></p>');
    const shown = html({ text: "복사했어요", id: 1 });
    expect(shown).toContain('<p class="sr-only" role="status" aria-live="polite"><span>복사했어요</span></p>');
    // 보이는 토스트는 알림 영역이 아니다 (두 번 읽지 않게)
    expect(shown.match(/role="status"/g)).toHaveLength(1);
    expect(shown.match(/aria-live/g)).toHaveLength(1);
    expect(shown).toMatch(/<div class="toast"[^>]*><span>복사했어요<\/span><\/div>/);
  });
});
