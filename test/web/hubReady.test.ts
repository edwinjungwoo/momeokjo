import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HUBS, PUBLIC_HUBS } from "../../shared/hubs";
import { HubName, hubOptionLabel } from "../../web/admin/Overview";
import { HubPicker } from "../../web/components/HubPicker";
import { UNREADY_HUB } from "../helpers/unreadyHub";

// R62: 준비 중 동작은 테스트 전용 준비 중 거점으로 본다 (운영 준비 중 거점은 공개되면 바뀐다) — HUBS에 더한다
vi.mock("../../shared/hubs", async (orig) => (await import("../helpers/unreadyHub")).withUnreadyHub(orig));

// 화면 코드 원문 (Vite가 빌드 시점에 묶어 준다)
const sources = import.meta.glob("../../web/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const UNREADY = HUBS.filter((h) => !h.ready);

describe("R62 준비 중 거점 — 화면", () => {
  it("R62: 첫 접속 질문(R61)은 공개 거점만 보인다", () => {
    const html = renderToStaticMarkup(createElement(HubPicker, { onPick: () => {}, onDismiss: () => {} }));
    for (const h of PUBLIC_HUBS) expect(html, h.id).toContain(h.name);
    // 운영 준비 중 거점(지금은 역삼역·선정릉역)과 테스트 전용 준비 중 거점 모두
    expect(UNREADY).toContain(UNREADY_HUB);
    for (const h of UNREADY) expect(html, h.id).not.toContain(h.name);
    // 가나다순, 이름 옆 호선 배지 (읽기 도구에는 노선 이름)
    const at = PUBLIC_HUBS.map((h) => [h.name, html.indexOf(h.name)] as const).sort((a, b) => a[1] - b[1]).map(([n]) => n);
    expect(at).toEqual([...at].sort((a, b) => a.localeCompare(b, "ko")));
    expect(html).toContain('aria-label="2호선, 신분당선"');
  });

  it("R62: 관리 화면 밖의 화면 코드는 모든 거점(HUBS·hubById·isHubId)을 쓰지 않는다 — 거점 메뉴·질문·설정은 공개 거점만", () => {
    const user = Object.entries(sources).filter(([p]) => !p.includes("/web/admin/"));
    expect(user.length).toBeGreaterThan(10);
    for (const [p, code] of user) {
      expect(code, p).not.toMatch(/(?<![\w.])HUBS\b/);
      expect(code, p).not.toMatch(/(?<![\w.])(?:hubById|isHubId)\b/);
    }
    // 거점 메뉴·첫 접속 질문은 pickerHubs()(공개 거점 가나다순)를 역 검색(R24 searchHubs)으로 걸러 그린다
    expect(sources["../../web/components/HubChip.tsx"]).toMatch(/searchHubs\(pickerHubs\(\), query\)/);
    expect(sources["../../web/components/HubPicker.tsx"]).toMatch(/searchHubs\(pickerHubs\(\), query\)/);
    expect(sources["../../web/hubLines.ts"]).toMatch(/\[\.\.\.PUBLIC_HUBS\]\.sort\(/);
  });

  it("R62: 관리 화면은 준비 중 거점도 보이고 '준비 중' 표시를 붙인다 (거점 고르기·운영 탭 거점 표)", () => {
    expect(hubOptionLabel(UNREADY_HUB.id)).toBe(`${UNREADY_HUB.name} (준비 중)`);
    expect(hubOptionLabel("ddp")).toBe("동대문역사문화공원역");
    expect(hubOptionLabel("gangnam")).toBe("강남역");
    const unready = renderToStaticMarkup(createElement(HubName, { id: UNREADY_HUB.id }));
    expect(unready).toContain(UNREADY_HUB.name);
    expect(unready).toContain("준비 중");
    expect(renderToStaticMarkup(createElement(HubName, { id: "pangyo" }))).not.toContain("준비 중");
    expect(renderToStaticMarkup(createElement(HubName, { id: "yeouido" }))).not.toContain("준비 중");
    // 모르는 id(예전 이벤트)는 id 그대로, 표시 없이
    expect(renderToStaticMarkup(createElement(HubName, { id: "atlantis" }))).toBe("atlantis");
    const page = sources["../../web/admin/AdminPage.tsx"];
    expect(page).toMatch(/HUBS\.map\(/);
    expect(page).toMatch(/hubOptionLabel\(/);
    expect(sources["../../web/admin/Ops.tsx"]).toMatch(/<HubName /);
  });
});
