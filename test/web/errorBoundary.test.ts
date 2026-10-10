import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppErrorBoundary } from "../../web/components/AppErrorBoundary";

describe("R43 화면이 비지 않게 (오류 경계)", () => {
  it("R43: 그리다가 던지면(예: 이상한 링크) 흰 화면 대신 오류 안내와 '다시 시도하기' — 평소에는 자식 그대로", () => {
    expect(AppErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const ok = renderToStaticMarkup(createElement(AppErrorBoundary, null, createElement("p", null, "앱")));
    expect(ok).toBe("<p>앱</p>");
    const b = new AppErrorBoundary({ children: null });
    b.state = { failed: true };
    const html = renderToStaticMarkup(b.render() as never);
    expect(html).toContain("앗! 일시적인 오류가 발생했어요.");
    expect(html).toContain("다시 시도하기");
    expect(html).toContain('role="alert"');
  });
});
