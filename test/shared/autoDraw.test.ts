import { describe, expect, it } from "vitest";
import { AUTO_DRAW_ENOUGH, AUTO_DRAW_POLL_WAIT_MS, pollingElapsed, shouldAutoDraw, type AutoDrawInput } from "../../shared/autoDraw";

const OK: AutoDrawInput = {
  returning: true, shareLink: false, drawnThisSession: false, interacted: false,
  offDay: null, today: "2027-01-15", hasData: true, settled: true, pool: 5, polling: false, strict: 5, pollingMs: 0,
};

describe("R39 열자마자 3곳", () => {
  it("R39: 재방문자가 그냥 열었고 목록이 왔으면 한 번 자동으로 뽑는다", () => {
    expect(shouldAutoDraw(OK)).toBe(true);
    // 어제 끈 것은 오늘 상관없다
    expect(shouldAutoDraw({ ...OK, offDay: "2027-01-14" })).toBe(true);
    // 후보 1곳이어도 (완화 포함) 뽑는다
    expect(shouldAutoDraw({ ...OK, pool: 1 })).toBe(true);
  });

  it("R39: 첫 방문, 공유 링크, 이번 세션에 이미 뽑음, 이미 누름, 오늘 끔, 목록 전, 후보 0곳이면 뽑지 않는다", () => {
    expect(shouldAutoDraw({ ...OK, returning: false })).toBe(false);
    expect(shouldAutoDraw({ ...OK, shareLink: true })).toBe(false);
    expect(shouldAutoDraw({ ...OK, drawnThisSession: true })).toBe(false);
    expect(shouldAutoDraw({ ...OK, interacted: true })).toBe(false);
    expect(shouldAutoDraw({ ...OK, offDay: "2027-01-15" })).toBe(false);
    expect(shouldAutoDraw({ ...OK, hasData: false })).toBe(false);
    expect(shouldAutoDraw({ ...OK, pool: 0 })).toBe(false);
  });

  it("R39: 목록이 아직 채워지는 중(pending 폴링 중)이면 기다린다 — 일부만 온 목록으로 뽑지 않는다", () => {
    expect(shouldAutoDraw({ ...OK, settled: false })).toBe(false);
    expect(shouldAutoDraw({ ...OK, settled: false, pool: 40 })).toBe(false);
  });

  it("R39: 폴링 중이어도 지금 반경의 조건 맞는 후보가 30곳 이상이면 기다리지 않고 뽑는다", () => {
    const polling = { ...OK, settled: false, polling: true, pollingMs: 0 };
    expect(AUTO_DRAW_ENOUGH).toBe(30);
    expect(shouldAutoDraw({ ...polling, strict: 30, pool: 30 })).toBe(true);
    expect(shouldAutoDraw({ ...polling, strict: 29, pool: 40 })).toBe(false);
  });

  it("R39: 폴링이 5초 넘게 이어지면 후보가 적어도 그때까지 온 목록으로 뽑는다", () => {
    const polling = { ...OK, settled: false, polling: true, strict: 3 };
    expect(AUTO_DRAW_POLL_WAIT_MS).toBe(5000);
    expect(shouldAutoDraw({ ...polling, pollingMs: 4999 })).toBe(false);
    expect(shouldAutoDraw({ ...polling, pollingMs: 5000 })).toBe(true);
    // 완화로만 채운 후보(조건 맞는 곳 0)여도 뽑을 곳이 있으면 뽑는다
    expect(shouldAutoDraw({ ...polling, pollingMs: 5000, strict: 0, pool: 2 })).toBe(true);
    expect(shouldAutoDraw({ ...polling, pollingMs: 5000, strict: 0, pool: 0 })).toBe(false);
  });

  it("R39: 폴링 중이 아닌데 다 오지 않은 목록(첫 응답 전, 하루 넘은 기기 저장본)은 후보가 많아도 기다린다", () => {
    expect(shouldAutoDraw({ ...OK, settled: false, polling: false, strict: 200, pool: 200, pollingMs: 60_000 })).toBe(false);
  });

  it("R39: 일찍 뽑을 때도 다른 조건(첫 방문·공유 링크·이미 뽑음·이미 누름·오늘 끔·목록 전)은 그대로 막는다", () => {
    const early = { ...OK, settled: false, polling: true, strict: 50, pool: 50, pollingMs: 9000 };
    expect(shouldAutoDraw(early)).toBe(true);
    expect(shouldAutoDraw({ ...early, returning: false })).toBe(false);
    expect(shouldAutoDraw({ ...early, shareLink: true })).toBe(false);
    expect(shouldAutoDraw({ ...early, drawnThisSession: true })).toBe(false);
    expect(shouldAutoDraw({ ...early, interacted: true })).toBe(false);
    expect(shouldAutoDraw({ ...early, offDay: "2027-01-15" })).toBe(false);
    expect(shouldAutoDraw({ ...early, hasData: false })).toBe(false);
  });

  it("R39: 5초 타이머가 울렸으면(waited) 시계 차이로 4,998ms로 재지더라도 폴링 대기를 다 채운 것으로 본다", () => {
    const start = 1_000_000;
    expect(pollingElapsed(true, start, start + 4998)).toBe(AUTO_DRAW_POLL_WAIT_MS);
    expect(shouldAutoDraw({ ...OK, settled: false, polling: true, strict: 3, pollingMs: pollingElapsed(true, start, start + 4998) })).toBe(true);
    expect(pollingElapsed(false, start, start + 1200)).toBe(1200);
    expect(pollingElapsed(false, null, start)).toBe(0);
  });
});
