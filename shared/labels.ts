/**
 * R22′: 뽑힌 3곳의 지도 이름표가 서로 덮지 않게 한다 (QA x-04: 가까운 두 곳의 이름표가 겹쳐 읽을 수 없었다).
 * 화면 좌표(px)의 상자로만 판단하는 순수 함수 — 지도 SDK는 web/components/MapView.tsx가 다룬다.
 */
export type LabelBox = { id: string; x: number; y: number; w: number; h: number };

/** styles.css의 .pin--pick::after와 같은 값: 좌우 여백 10, 높이 26(12px × 1.5 + 위아래 4), 글자 최대 180, 핀 중심에서 위로 18(핀 32의 절반 + 2) */
export const PICK_LABEL = { padX: 10, height: 26, maxText: 180, gapAbovePin: 18 } as const;

/** 핀 중심(컨테이너 px)과 글자 너비로 이름표 상자를 만든다 */
export function pickLabelBox(id: string, pin: { x: number; y: number }, textWidth: number): LabelBox {
  const w = Math.min(textWidth, PICK_LABEL.maxText) + PICK_LABEL.padX * 2;
  const h = PICK_LABEL.height;
  return { id, x: pin.x - w / 2, y: pin.y - PICK_LABEL.gapAbovePin - h, w, h };
}

/** 번호 배지 지름: 24 + 흰 테두리 2×2 (.pin--pick::before) */
export const PICK_BADGE = 28;

/** 핀 중심(컨테이너 px)의 번호 배지 상자 */
export function pickBadgeBox(id: string, pin: { x: number; y: number }): LabelBox {
  return { id, x: pin.x - PICK_BADGE / 2, y: pin.y - PICK_BADGE / 2, w: PICK_BADGE, h: PICK_BADGE };
}

const near = (a: LabelBox, b: LabelBox, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * 순위 순서(앞이 높은 순위)의 이름표 상자에서 숨길 id. 앞의 보이는 이름표나 앞 순위의 번호 배지(badges, 같은 id)와
 * gap(px)보다 가까우면 숨긴다. 숨긴 이름표는 뒤의 이름표를 가리지 않는다. 번호 배지는 따로라 늘 보인다.
 */
export function hiddenLabels(boxes: LabelBox[], gap = 2, badges: LabelBox[] = []): Set<string> {
  const shown: LabelBox[] = [];
  const hidden = new Set<string>();
  const before = new Set<string>();
  for (const b of boxes) {
    const blockers = [...shown, ...badges.filter((x) => before.has(x.id))];
    if (blockers.some((s) => near(s, b, gap))) hidden.add(b.id);
    else shown.push(b);
    before.add(b.id);
  }
  return hidden;
}
