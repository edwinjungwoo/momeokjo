import { describe, expect, it } from "vitest";
import { MIN_MAP_VISIBLE, copyrightCorner, sheetCover } from "../../web/mapCover";

describe("R28 지도 로고·축척은 시트에 가리지 않는다", () => {
  // 375×812: 지도 칸은 상단바 아래 53px부터 40dvh(325px)
  const wrap = { top: 53, bottom: 378 };

  it("R28: 시트가 없거나 지도 칸 아래에서 시작하면 줄이지 않는다", () => {
    expect(sheetCover(wrap, null)).toBe(0);
    expect(sheetCover(wrap, 378)).toBe(0);
    expect(sheetCover(wrap, 500)).toBe(0);
  });

  it("R28: 시트가 지도 아래쪽을 덮으면 덮은 높이만큼 줄인다 (px 정수로 반올림)", () => {
    expect(sheetCover(wrap, 300)).toBe(78);
    expect(sheetCover(wrap, 246.4)).toBe(132);
  });

  it("R28: 시트가 지도를 거의 다 덮어도 지도는 MIN_MAP_VISIBLE만큼 남긴다 (높이 0이면 SDK가 그리지 못한다)", () => {
    expect(MIN_MAP_VISIBLE).toBeGreaterThanOrEqual(32);
    expect(sheetCover(wrap, 60)).toBe(325 - MIN_MAP_VISIBLE);
    expect(sheetCover(wrap, -100)).toBe(325 - MIN_MAP_VISIBLE);
    // 지도 칸 자체가 그보다 낮으면 줄이지 않는다
    expect(sheetCover({ top: 0, bottom: 20 }, 0)).toBe(0);
  });

  it("R28: 로고 자리 — 모바일은 왼쪽 아래(시트 위), 데스크톱은 결과 오버레이가 왼쪽 아래를 덮어서 오른쪽 아래", () => {
    expect(copyrightCorner(false)).toBe("BOTTOMLEFT");
    expect(copyrightCorner(true)).toBe("BOTTOMRIGHT");
  });
});
