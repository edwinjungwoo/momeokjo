/**
 * R22′: 뽑힌 3곳의 지도 이름표가 서로 덮지 않게 한다 (QA x-04: 가까운 두 곳의 이름표가 겹쳐 읽을 수 없었다).
 * 화면 좌표(px)의 상자로만 판단하는 순수 함수 — 지도 SDK는 web/components/MapView.tsx가 다룬다.
 */
export type LabelBox = { id: string; x: number; y: number; w: number; h: number };

/**
 * styles.css의 .pin--pick::after와 같은 값: 좌우 여백 10, 높이 26(12px × 1.5 + 위아래 4),
 * 여백 포함 최대 너비 180(box-sizing: border-box), 핀 중심에서 위로 18(핀 32의 절반 + 2)
 */
export const PICK_LABEL = { padX: 10, height: 26, maxWidth: 180, gapAbovePin: 18 } as const;

/** 핀 중심(컨테이너 px)과 글자 너비로 이름표 상자를 만든다 */
export function pickLabelBox(id: string, pin: { x: number; y: number }, textWidth: number): LabelBox {
  const w = Math.min(textWidth + PICK_LABEL.padX * 2, PICK_LABEL.maxWidth);
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

/** 이름표가 지도 컨테이너 가장자리에서 떨어질 최소 여백(px) */
export const LABEL_EDGE = 8;

/**
 * 이름표 상자가 컨테이너(0..width) 좌우 여백 안에 들어오도록 가로로 밀 양(px). 안쪽이면 0.
 * 컨테이너보다 넓으면 왼쪽 여백에 맞춘다 (잘리지 않게 — 글자는 CSS 말줄임이 줄인다)
 */
export function clampLabelX(box: LabelBox, width: number, margin = LABEL_EDGE): number {
  const min = margin;
  const max = width - margin - box.w;
  if (max < min || box.x < min) return min - box.x;
  if (box.x > max) return max - box.x;
  return 0;
}

export type PickLayout = {
  /** 앞 번호의 이름표·배지와 겹쳐 숨길 이름표 (펼친 후보는 CSS가 늘 보인다) */
  hidden: Set<string>;
  /** 이름표마다 가로로 민 양(px) — CSS 변수 --label-dx */
  shift: Map<string, number>;
  /** 쌓는 순서(위 → 아래). 보이는 이름표가 다른 번호의 배지를 덮으면 그 배지의 핀을 이름표 위로 올린다 */
  order: string[];
};

/**
 * R22′: 뽑힌 핀들의 이름표 배치. labels·badges는 같은 id, 순위 순서(앞이 높은 순위).
 * 1) 화면 밖으로 나가는 이름표를 안쪽으로 민다 2) 민 자리로 hiddenLabels 3) 보이는 이름표(펼친 후보가 있으면 그것만)가
 * 덮는 배지의 핀을 그 이름표의 핀보다 위에 쌓는다. 나머지 순서는 펼친 후보 먼저, 그다음 번호 순.
 * 핀 하나(오버레이)에 배지와 이름표가 함께 있어서 배지만 따로 올릴 수 없기 때문에 핀 순서로 푼다
 */
export function layoutPicks(
  labels: LabelBox[],
  badges: LabelBox[],
  opts: { width: number; gap?: number; focusId?: string | null },
): PickLayout {
  const shift = new Map<string, number>();
  const moved = labels.map((b) => {
    const dx = clampLabelX(b, opts.width);
    shift.set(b.id, dx);
    return dx === 0 ? b : { ...b, x: b.x + dx };
  });
  const hidden = hiddenLabels(moved, opts.gap ?? 2, badges);
  const focus = opts.focusId && labels.some((b) => b.id === opts.focusId) ? opts.focusId : null;
  const shown = moved.filter((b) => (focus ? b.id === focus : !hidden.has(b.id)));
  // above.get(k) = k보다 위에 있어야 하는 핀들 (k의 이름표가 그 배지를 덮는다)
  const above = new Map<string, Set<string>>();
  for (const l of shown) {
    for (const g of badges) {
      if (g.id !== l.id && near(l, g, 0)) {
        if (!above.has(l.id)) above.set(l.id, new Set());
        above.get(l.id)!.add(g.id);
      }
    }
  }
  const ids = labels.map((b) => b.id);
  const prefer = focus ? [focus, ...ids.filter((id) => id !== focus)] : ids;
  const order: string[] = [];
  const placed = new Set<string>();
  while (order.length < prefer.length) {
    const ready = (id: string) => [...(above.get(id) ?? [])].every((j) => placed.has(j) || !prefer.includes(j));
    // 순환은 생기지 않지만(덮을 수 있는 이름표는 뒤 번호 배지만, 또는 펼친 후보 하나) 생기면 선호 순서로 끊는다
    const next = prefer.find((id) => !placed.has(id) && ready(id)) ?? prefer.find((id) => !placed.has(id))!;
    order.push(next);
    placed.add(next);
  }
  return { hidden, shift, order };
}

/** R28: 평점 칩 상자 (컨테이너 px) */
export type ChipBox = LabelBox & {
  rating: number | null;
  reviews: number | null;
  /** 선택한 핀 — 평점과 상관없이 먼저 놓는다 */
  pinned?: boolean;
};

/** 겹침을 찾는 격자 한 칸(px). 칩(~50×22)보다 조금 커서 칩 하나가 보통 1~2칸에 든다 */
const CELL = 64;

/**
 * R28: 가까이 본 지도에서 서로 덮지 않게 남길 칩 id (나머지는 점으로 그린다).
 * 순서: 선택한 핀 → 평점 높은 순 → 리뷰 많은 순 → id. 앞에 놓인 칩이나 장애물(뽑힌 핀의 배지·이름표)과 겹치면 뺀다.
 * 격자 칸에 놓인 상자만 비교해서 정렬(n log n) + 칸 조회로 끝난다
 */
export function keptChips(chips: ChipBox[], obstacles: LabelBox[]): Set<string> {
  const grid = new Map<number, LabelBox[]>();
  // 칸 번호 하나로: 화면 크기(수천 px)보다 넉넉한 폭으로 행·열을 섞는다
  const key = (cx: number, cy: number) => cy * 100_003 + cx;
  const cells = (b: LabelBox, f: (k: number) => boolean | void): boolean => {
    const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + b.w) / CELL);
    const y0 = Math.floor(b.y / CELL), y1 = Math.floor((b.y + b.h) / CELL);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) if (f(key(cx, cy))) return true;
    return false;
  };
  const put = (b: LabelBox) => {
    cells(b, (k) => {
      const list = grid.get(k);
      if (list) list.push(b);
      else grid.set(k, [b]);
    });
  };
  const hits = (b: LabelBox) => cells(b, (k) => grid.get(k)?.some((o) => near(o, b, 0)));
  for (const o of obstacles) put(o);
  const sorted = [...chips].sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      (b.rating ?? -1) - (a.rating ?? -1) ||
      (b.reviews ?? -1) - (a.reviews ?? -1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const kept = new Set<string>();
  for (const c of sorted) {
    if (!c.pinned && hits(c)) continue;
    put(c);
    kept.add(c.id);
  }
  return kept;
}
