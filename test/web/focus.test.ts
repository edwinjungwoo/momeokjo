import { describe, expect, it, vi } from "vitest";
import { restoreFocus } from "../../web/focus";

const el = (connected = true) => ({ isConnected: connected, focus: vi.fn() });

describe("R22′/R23′ 카드·결과 시트를 닫으면 초점을 연 곳으로", () => {
  it("R22′: 닫혀서 초점이 body로 떨어졌으면 연 요소(목록 줄·뽑기 버튼)로 돌려준다", () => {
    const body = { focus: vi.fn() };
    const opener = el();
    restoreFocus({ activeElement: body, body } as never, opener as never);
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("R22′: 연 요소가 없어졌으면(다시 그려진 목록 등) 대신 갈 곳(뽑기 버튼)으로, 그것도 없으면 그대로", () => {
    const body = { focus: vi.fn() };
    const draw = el();
    restoreFocus({ activeElement: body, body } as never, el(false) as never, () => draw as never);
    expect(draw.focus).toHaveBeenCalledOnce();
    // 자동 뽑기로 열려 연 요소가 body면 대신 갈 곳으로
    const draw2 = el();
    restoreFocus({ activeElement: body, body } as never, body as never, () => draw2 as never);
    expect(draw2.focus).toHaveBeenCalledOnce();
    expect(body.focus).not.toHaveBeenCalled();
    restoreFocus({ activeElement: null, body } as never, null, () => null);
  });

  it("R22′: 사용자가 이미 다른 곳(모먹죠?·다른 줄)을 눌러 초점이 거기 있으면 옮기지 않는다", () => {
    const body = { focus: vi.fn() };
    const opener = el();
    const elsewhere = el();
    restoreFocus({ activeElement: elsewhere, body } as never, opener as never);
    expect(opener.focus).not.toHaveBeenCalled();
  });
});
