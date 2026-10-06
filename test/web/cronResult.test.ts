import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CronSummary } from "../../shared/dashboard";
import { CronResult } from "../../web/admin/CronResult";

const base: CronSummary = { at: 0, collected: 3, incomplete: 0, enriched: 4, failed: 1, calls: 5, rolled: 0 };
const html = (cron: CronSummary | null, detailOnly = false) => renderToStaticMarkup(createElement(CronResult, { cron, detailOnly }));

describe("관리 화면 운영 탭 — 마지막 Cron 결과", () => {
  it("R59: 보통 실행은 격자·상세·외부 호출 수만, 경고 표시 없이", () => {
    const h = html(base);
    expect(h).toContain("격자 3");
    expect(h).toContain("상세 4");
    expect(h).toContain("실패 1");
    expect(h).not.toContain("lv-warn");
  });

  it("R10/R38: 저장 오류(enrichError)와 D1 호출 예산으로 건너뛴 단계(d1Skipped)는 경고 알약으로 보이고, 센 수는 그대로 보인다", () => {
    const h = html({ ...base, enrichError: true, d1Skipped: ["expired", "rollup"] });
    expect(h).toContain("상세 4");
    expect(h).toMatch(/pill lv-warn[^>]*>저장 오류/);
    expect(h).toMatch(/pill lv-warn[^>]*>D1 예산으로 건너뜀 · 만료 갱신·집계/);
  });

  it("R38: 읽기 예산으로 건너뛴 실행·기록 없음", () => {
    expect(html({ ...base, skipped: "read_budget" })).toMatch(/pill lv-warn[^>]*>건너뜀 · 읽기 예산/);
    expect(html(null)).toBe("–");
  });

  it("R63: 상세만 실행(홀수 분)의 결과는 격자·집계 없이 상세·외부 호출 수만, 쿨다운·frozen이면 \"상세 멈춤\"", () => {
    const h = html({ ...base, collected: 0, rolled: 0 } as CronSummary, true);
    expect(h).not.toContain("격자");
    expect(h).toContain("상세 4");
    expect(h).toContain("외부 호출 5");
    expect(html({ ...base, skipped: "paused" }, true)).toMatch(/pill lv-warn[^>]*>건너뜀 · 상세 멈춤/);
  });
});
