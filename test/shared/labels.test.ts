import { describe, expect, it } from "vitest";
import { PICK_BADGE, PICK_LABEL, hiddenLabels, pickBadgeBox, pickLabelBox, type LabelBox } from "../../shared/labels";

const box = (id: string, x: number, y: number, w = 80, h = 26): LabelBox => ({ id, x, y, w, h });

describe("R22′ 지도 이름표 겹침", () => {
  it("R22′: 이름표는 핀 중심 위쪽 가운데에 놓이고, 너비는 글자 + 좌우 여백(최대 180 + 여백)", () => {
    expect(PICK_LABEL).toEqual({ padX: 10, height: 26, maxText: 180, gapAbovePin: 18 });
    expect(pickLabelBox("a", { x: 100, y: 200 }, 60)).toEqual({ id: "a", x: 60, y: 156, w: 80, h: 26 });
    expect(pickLabelBox("b", { x: 100, y: 200 }, 400).w).toBe(200);
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
});
