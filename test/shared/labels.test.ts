import { describe, expect, it } from "vitest";
import {
  LABEL_EDGE, PICK_BADGE, PICK_LABEL, clampLabelX, hiddenLabels, layoutPicks, pickBadgeBox, pickLabelBox, type LabelBox,
} from "../../shared/labels";

const box = (id: string, x: number, y: number, w = 80, h = 26): LabelBox => ({ id, x, y, w, h });

describe("R22′ 지도 이름표 겹침", () => {
  it("R22′: 이름표는 핀 중심 위쪽 가운데에 놓이고, 너비는 min(글자 + 좌우 여백 20, 180) (border-box)", () => {
    expect(PICK_LABEL).toEqual({ padX: 10, height: 26, maxWidth: 180, gapAbovePin: 18 });
    expect(pickLabelBox("a", { x: 100, y: 200 }, 60)).toEqual({ id: "a", x: 60, y: 156, w: 80, h: 26 });
    expect(pickLabelBox("b", { x: 100, y: 200 }, 400).w).toBe(180);
    expect(pickLabelBox("c", { x: 100, y: 200 }, 165).w).toBe(180);
    expect(pickLabelBox("d", { x: 100, y: 200 }, 159).w).toBe(179);
  });

  it("R22′: 겹치지 않으면 모두 보인다", () => {
    expect(hiddenLabels([box("1", 0, 0), box("2", 0, 40), box("3", 200, 0)])).toEqual(new Set());
  });

  it("R22′: 낮은 순위 이름표가 높은 순위와 겹치면 낮은 쪽을 숨긴다 (번호 배지는 그대로)", () => {
    expect(hiddenLabels([box("1", 0, 0), box("2", 40, 10)])).toEqual(new Set(["2"]));
    // 순서가 곧 순위: 앞의 것이 남는다
    expect(hiddenLabels([box("2", 40, 10), box("1", 0, 0)])).toEqual(new Set(["1"]));
  });

  it("R22′: 숨긴 이름표는 다음 이름표를 가리지 않는다 — 3번은 보이는 1번하고만 비교한다", () => {
    // 2는 1과 겹쳐 숨고, 3은 2와만 겹치고 1과는 떨어져 있다
    expect(hiddenLabels([box("1", 0, 0), box("2", 60, 0), box("3", 120, 0)])).toEqual(new Set(["2"]));
    // 3이 1과도 겹치면 숨긴다
    expect(hiddenLabels([box("1", 0, 0), box("2", 300, 0), box("3", 50, 20)])).toEqual(new Set(["3"]));
  });

  it("R22′: 2px보다 가까우면 겹친 것으로 친다 (모서리가 붙어 보이지 않게)", () => {
    expect(hiddenLabels([box("1", 0, 0), box("2", 81, 0)])).toEqual(new Set(["2"]));
    expect(hiddenLabels([box("1", 0, 0), box("2", 82, 0)])).toEqual(new Set());
    expect(hiddenLabels([box("1", 0, 0), box("2", 0, 27)])).toEqual(new Set(["2"]));
    expect(hiddenLabels([box("1", 0, 0), box("2", 0, 28)])).toEqual(new Set());
  });

  it("R22′: x-04처럼 세 곳이 거의 같은 자리면 1번 이름표만 남는다", () => {
    const pts = [{ x: 150, y: 200 }, { x: 155, y: 190 }, { x: 170, y: 205 }];
    const boxes = pts.map((p, i) => pickLabelBox(String(i + 1), p, [36, 100, 90][i]));
    expect(hiddenLabels(boxes)).toEqual(new Set(["2", "3"]));
  });

  it("R22′: 번호 배지 상자는 핀 중심 둘레 28px (24 + 흰 테두리 2×2)", () => {
    expect(PICK_BADGE).toBe(28);
    expect(pickBadgeBox("1", { x: 100, y: 200 })).toEqual({ id: "1", x: 86, y: 186, w: 28, h: 28 });
  });

  it("R22′: 낮은 번호 이름표가 높은 번호의 배지를 덮어도 숨긴다 (배지는 숨기지 않으므로 이름표가 비킨다)", () => {
    // 2의 이름표는 1의 이름표와는 떨어져 있지만 1의 배지 위에 걸친다 (긴 이름)
    const labels = [box("1", 100, 0, 60), box("2", 40, 40, 200)];
    const badges = [box("1", 116, 46, 28, 28), box("2", 126, 86, 28, 28)];
    expect(hiddenLabels(labels, 2, badges)).toEqual(new Set(["2"]));
    // 자기 배지나 낮은 번호의 배지와 겹치는 것은 상관없다 — 1의 이름표는 2의 배지와 겹쳐도 보인다
    expect(hiddenLabels([box("1", 100, 80, 60), box("2", 300, 0)], 2, [box("1", 116, 120, 28, 28), box("2", 120, 90, 28, 28)])).toEqual(new Set());
  });

  it("R22′: 화면 가장자리를 넘는 이름표는 안쪽으로 밀어 넣는다 (여백 8px, 잘리지 않게)", () => {
    expect(LABEL_EDGE).toBe(8);
    // 오른쪽으로 넘침: 오른쪽 끝이 375 - 8에 오게
    expect(clampLabelX(box("1", 330, 0, 100), 375)).toBe(-63);
    // 왼쪽으로 넘침
    expect(clampLabelX(box("1", -20, 0, 100), 375)).toBe(28);
    // 안쪽이면 그대로
    expect(clampLabelX(box("1", 8, 0, 100), 375)).toBe(0);
    expect(clampLabelX(box("1", 267, 0, 100), 375)).toBe(0);
    // 화면보다 넓으면 왼쪽 여백에 맞춘다
    expect(clampLabelX(box("1", -50, 0, 180), 150)).toBe(58);
  });

  it("R22′: 밀어 넣은 자리로 겹침을 판단하고, 밀린 양을 돌려준다", () => {
    // 1은 오른쪽 끝에서 밀려 들어와 2와 겹친다 (밀기 전에는 떨어져 있음)
    const labels = [box("1", 330, 0, 100), box("2", 230, 0, 60)];
    const r = layoutPicks(labels, [], { width: 375 });
    expect(r.shift.get("1")).toBe(-63);
    expect(r.shift.get("2")).toBe(0);
    expect(r.hidden).toEqual(new Set(["2"]));
  });

  it("R22′: 높은 순위 이름표가 낮은 순위 배지를 덮으면 이름표는 두고 그 배지를 위로 올린다 (배지는 늘 보인다)", () => {
    // 1의 이름표가 2의 배지 위에 걸친다. 2의 이름표는 멀리 있어 보인다
    const labels = [box("1", 100, 100, 120), box("2", 300, 0, 60), box("3", 0, 300, 60)];
    const badges = [box("1", 146, 140, 28, 28), box("2", 180, 110, 28, 28), box("3", 16, 340, 28, 28)];
    const r = layoutPicks(labels, badges, { width: 600 });
    expect(r.hidden).toEqual(new Set());
    // 위에서 아래 순서: 2가 1보다 위, 나머지는 번호 순
    expect(r.order).toEqual(["2", "1", "3"]);
  });

  it("R22′: 덮는 것이 없으면 번호 순서대로 1이 맨 위, 펼친 후보가 있으면 그 후보가 맨 위", () => {
    const labels = [box("1", 0, 0, 60), box("2", 200, 0, 60), box("3", 400, 0, 60)];
    const badges = [box("1", 16, 40, 28, 28), box("2", 216, 40, 28, 28), box("3", 416, 40, 28, 28)];
    expect(layoutPicks(labels, badges, { width: 600 }).order).toEqual(["1", "2", "3"]);
    expect(layoutPicks(labels, badges, { width: 600, focusId: "2" }).order).toEqual(["2", "1", "3"]);
  });

  it("R22′: 펼친 후보의 이름표만 보일 때 그 이름표가 다른 배지를 덮으면 그 배지를 위로 올린다", () => {
    // 2(펼침)의 이름표가 1의 배지를 덮는다
    const labels = [box("1", 0, 0, 60), box("2", 100, 100, 160)];
    const badges = [box("1", 150, 110, 28, 28), box("2", 166, 140, 28, 28)];
    const r = layoutPicks(labels, badges, { width: 600, focusId: "2" });
    expect(r.order).toEqual(["1", "2"]);
  });
});
