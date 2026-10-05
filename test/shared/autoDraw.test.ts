import { describe, expect, it } from "vitest";
import { shouldAutoDraw, type AutoDrawInput } from "../../shared/autoDraw";

const OK: AutoDrawInput = {
  returning: true, shareLink: false, drawnThisSession: false, interacted: false,
  offDay: null, today: "2027-01-15", hasData: true, settled: true, pool: 5,
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
});
