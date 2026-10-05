import { describe, expect, it } from "vitest";
import { STALE_DETAIL_DAYS, detailAgeDays, freshnessText } from "../../shared/freshness";

const NOW = 1_800_000_000_000;
const D = 24 * 3600_000;

describe("R44 정보 기준 시점", () => {
  it("R44: frozen이면 가장 최근 상세로부터 지난 날 수(최소 1)를 보여준다", () => {
    expect(detailAgeDays(NOW - D, NOW - 2.5 * D, NOW)).toBe(2);
    expect(detailAgeDays(NOW - 1000, NOW - 3600_000, NOW)).toBe(1);
    // 상세 시각을 모르면 frozen 시작 시각으로
    expect(detailAgeDays(NOW - 3 * D, null, NOW)).toBe(3);
  });

  it("R44: frozen이 아니면 가장 최근 상세가 4일보다 오래됐을 때만", () => {
    expect(STALE_DETAIL_DAYS).toBe(4);
    expect(detailAgeDays(null, NOW - 4 * D, NOW)).toBeNull();
    expect(detailAgeDays(null, NOW - 4 * D - 1, NOW)).toBe(4);
    expect(detailAgeDays(null, NOW - 6.2 * D, NOW)).toBe(6);
    expect(detailAgeDays(null, null, NOW)).toBeNull();
  });

  it("R44: 문구", () => {
    expect(freshnessText(2)).toBe("평점·메뉴는 2일 전 기준이에요");
  });
});
