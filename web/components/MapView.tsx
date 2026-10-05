import { useEffect, useRef, useState } from "react";
import { chipToggles, keptChips, layoutPicks, pickBadgeBox, pickLabelBox, type ChipBox, type LabelBox } from "../../shared/labels";
import type { ApiPlace, CategoryGroup, LatLng } from "../../shared/types";
import { loadKakaoMaps } from "../kakaoLoader";

const ACCENT = "#FF683D";
/** 줌 단계: 레벨 5 이상=far(전부 점), 4=mid(평점 높은 곳만 칩), 3 이하=near(전부 칩) */
type Zoom = "far" | "mid" | "near";
const zoomOf = (level: number): Zoom => (level >= 5 ? "far" : level === 4 ? "mid" : "near");
const TOP_RATING = 4;

const GLYPH: Record<CategoryGroup, string> = {
  korean: "🍚",
  chinese: "🥟",
  japanese: "🍣",
  western: "🍝",
  asian: "🍜",
  snack: "🍔",
  bar: "🍺",
  dessert: "🍰",
  etc: "🍴",
};

/** 확대했을 때 칩 글자: "🍚 4.3" (평점이 없으면 아이콘만) */
function chipText(p: ApiPlace): string {
  const r = p.detail?.rating ?? null;
  return r === null ? GLYPH[p.group] : `${GLYPH[p.group]} ${r.toFixed(1)}`;
}

type Props = {
  center: LatLng;
  radius: number;
  places: ApiPlace[];
  selectedId: string | null;
  /** R22′: 뽑힌 후보 id (순서 = 번호 1/2/3). 모두 강조하고 번호를 단다 */
  picks: string[];
  /** 펼친 후보 id. 그 핀으로 이동하고 맨 위에 둔다 */
  focusId: string | null;
  onSelect: (id: string) => void;
};

/** 데스크톱은 결과 오버레이가 지도 왼쪽을, 모바일은 바텀 시트가 지도 아래를 가린다 */
const isDesktop = () => window.matchMedia?.("(min-width: 900px)").matches ?? false;
const MIN_FIT_LEVEL = 3;
const FIT_PAD = 40;

const hasSize = (node: HTMLElement) => node.clientWidth > 0 && node.clientHeight > 0;

/** 지도 컨테이너 크기와 글꼴. 이름표·칩 배치가 핀 클래스·스타일을 쓰기 전에 한 번 읽어 둘 다에 넘긴다 (쓴 뒤에 읽으면 스타일·레이아웃을 다시 계산한다) */
type Frame = { width: number; height: number; font: string };

/** R28: 칩을 고를 때 화면 밖으로 더 보는 폭(px, 칩 하나 너비 넉넉히). 위경도로 먼저 거르고, 투영한 뒤 가로 ±80·세로 ±40으로 한 번 더 거른다 */
const CHIP_MARGIN = 80;

/** 이름표 글자 너비 (.pin--pick::after와 같은 12px 굵기 600). 캔버스 하나를 다시 쓴다 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function labelTextWidth(text: string, fontFamily: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 12;
  measureCtx.font = `600 12px ${fontFamily}`;
  return measureCtx.measureText(text).width;
}

/** R28: 칩 글자 너비 (.pin-chip 11px 굵기 700, 선택한 핀은 12px). 글자 종류가 적어서(아이콘 × 평점) 한 번 잰 값을 다시 쓴다 */
const chipWidths = new Map<string, number>();
function chipTextWidth(text: string, px: number, fontFamily: string): number {
  const key = `${px}|${text}`;
  let w = chipWidths.get(key);
  if (w === undefined) {
    measureCtx ??= document.createElement("canvas").getContext("2d");
    if (measureCtx) {
      measureCtx.font = `700 ${px}px ${fontFamily}`;
      w = measureCtx.measureText(text).width;
    } else w = text.length * px;
    chipWidths.set(key, w);
  }
  return w;
}

/** R28: 거점 핀, 반경 원(점선), 후보 핀(CustomOverlay 버튼). 선택된 핀은 커지고 한 번 퍼진다. */
export function MapView({ center, radius, places, selectedId, picks, focusId, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(undefined);
  const circle = useRef<any>(undefined);
  const centerPin = useRef<any>(undefined);
  const overlays = useRef(new Map<string, any>());
  const needsFit = useRef(true);
  const handlers = useRef({ onSelect });
  /** 뽑힌 후보 id (순서 = 번호). 지도 이벤트(확대·이동 끝)에서 이름표 겹침을 다시 계산할 때 읽는다 */
  const picksRef = useRef<string[]>(picks);
  const focusRef = useRef<string | null>(focusId);
  /** 이름표를 가로로 민(--label-dx) 핀 id */
  const shifted = useRef(new Set<string>());
  const placesRef = useRef(new Map<string, ApiPlace>());
  const selectedRef = useRef<string | null>(selectedId);
  /** 칩이 겹칠 때 피할 상자: 보이는 이름표(민 자리)와 번호 배지, 선택한 핀의 이름표 */
  const pickObstacles = useRef<LabelBox[]>([]);
  /** 칩 대신 점으로 그리는 핀 id (.pin--nochip) */
  const noChip = useRef(new Set<string>());
  const layoutChips = useRef<(f?: Frame | null) => void>(() => {});
  const layoutLabels = useRef<(f?: Frame | null) => void>(() => {});
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 확대 수준에 따라 핀 모양만 CSS로 바꾼다 (오버레이는 다시 만들지 않는다)
  const [zoom, setZoom] = useState<Zoom>("far");

  // SDK 이벤트 리스너는 한 번만 등록하므로 최신 콜백은 ref로 읽는다
  useEffect(() => {
    handlers.current = { onSelect };
  });

  const readFrame = (): Frame | null => {
    const node = el.current;
    return node ? { width: node.clientWidth, height: node.clientHeight, font: getComputedStyle(node).fontFamily } : null;
  };
  /** 이름표 → 칩 순서로 다시 배치한다. 크기·글꼴은 둘 다 쓰기 전에 한 번만 읽는다 (확대·이동 끝, 핀·결과 갱신) */
  const relayoutPins = () => {
    const f = readFrame();
    layoutLabels.current(f);
    layoutChips.current(f);
  };

  // 반경 원이 화면에 들어오게 맞춘다. 컨테이너 크기가 0이면 ResizeObserver가 크기가 생길 때 다시 맞춘다.
  const fitCircle = () => {
    const node = el.current;
    if (!map.current || !circle.current || !node) return;
    if (!hasSize(node)) {
      needsFit.current = true;
      return;
    }
    needsFit.current = false;
    map.current.setBounds(circle.current.getBounds(), 40, 24, 24, 24);
  };

  // 지도 생성 (한 번). 실패하면 "다시 시도"가 attempt를 올려 다시 실행한다.
  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | undefined;
    loadKakaoMaps(import.meta.env.VITE_KAKAO_JS_KEY)
      .then((kakao) => {
        const node = el.current;
        if (cancelled || !node || map.current) return;
        const pos = new kakao.maps.LatLng(center.lat, center.lng);
        const m = new kakao.maps.Map(node, { center: pos, level: 5 });
        const c = new kakao.maps.Circle({
          map: m,
          center: pos,
          radius,
          strokeWeight: 2,
          strokeColor: ACCENT,
          strokeOpacity: 0.9,
          strokeStyle: "dash",
          fillColor: ACCENT,
          fillOpacity: 0.06,
        });
        const dot = document.createElement("div");
        dot.className = "center-pin";
        const pin = new kakao.maps.CustomOverlay({ map: m, position: pos, content: dot, zIndex: 3 });
        kakao.maps.event.addListener(m, "zoom_changed", () => {
          setZoom(zoomOf(m.getLevel()));
          layoutLabels.current();
        });
        // 확대·이동이 끝나면 이름표 겹침을 다시 본다 (확대하면 떨어져서 다시 보일 수 있다).
        // 칩 겹침은 핀 수백 개를 훑으므로 확대 중 매 프레임(zoom_changed)이 아니라 끝났을 때(idle)만 다시 계산한다
        kakao.maps.event.addListener(m, "idle", relayoutPins);
        let lastWidth = node.clientWidth;
        const observer = new ResizeObserver(() => {
          if (!hasSize(node)) return;
          const keep = m.getCenter();
          const widthChanged = node.clientWidth !== lastWidth;
          lastWidth = node.clientWidth;
          m.relayout();
          // 너비가 바뀌면(회전, 창 크기) 원을 다시 맞춘다. 높이만 바뀌면(모바일 주소창) 중심을 유지한다.
          if (needsFit.current || widthChanged) fitCircle();
          else m.setCenter(keep);
        });
        ro = observer;
        observer.observe(node);
        // 설정이 모두 끝난 뒤에만 ref에 넣는다 (실패하면 죽은 지도가 남지 않게)
        map.current = m;
        circle.current = c;
        centerPin.current = pin;
        fitCircle();
        setZoom(zoomOf(m.getLevel()));
        setReady(true);
      })
      .catch((e) => {
        console.error("kakao map load failed", e);
        ro?.disconnect();
        ro = undefined;
        if (cancelled) return;
        // 일부만 만들어진 지도가 남아 다시 시도를 막지 않게 비운다
        map.current = null;
        circle.current = null;
        centerPin.current = null;
        el.current?.replaceChildren();
        setFailed(true);
      });
    return () => {
      cancelled = true;
      ro?.disconnect();
    };
    // 지도는 한 번만 만든다. center/radius 변경은 아래 effect가 반영한다.
  }, [attempt]);

  // 거점, 반경 변경
  useEffect(() => {
    if (!ready) return;
    const pos = new window.kakao.maps.LatLng(center.lat, center.lng);
    circle.current.setPosition(pos);
    circle.current.setRadius(radius);
    centerPin.current.setPosition(pos);
    fitCircle();
  }, [ready, center.lat, center.lng, radius]);

  // R22′: 뽑힌 3곳의 이름표 배치 (shared/labels.ts layoutPicks). 핀 좌표를 화면 px로 바꿔 상자를 비교한다
  // - 화면 가장자리를 넘는 이름표는 --label-dx로 안쪽으로 민다
  // - 앞 번호의 이름표·배지와 겹치는 이름표는 숨긴다 (번호 배지는 남는다)
  // - 보이는 이름표가 뒤 번호의 배지를 덮으면 그 핀을 위로 올린다 (배지는 늘 보인다)
  layoutLabels.current = (f = readFrame()) => {
    const m = map.current;
    if (!m || !f || typeof m.getProjection !== "function") return;
    const proj = m.getProjection();
    const font = f.font;
    const boxes = [];
    const badges = [];
    for (const id of picksRef.current) {
      const ov = overlays.current.get(id);
      if (!ov) continue;
      const pt = proj.containerPointFromCoords(ov.getPosition());
      const name = (ov.getContent() as HTMLElement).dataset.name ?? "";
      boxes.push(pickLabelBox(id, { x: pt.x, y: pt.y }, labelTextWidth(name, font)));
      badges.push(pickBadgeBox(id, { x: pt.x, y: pt.y }));
    }
    const { hidden: hide, shift, order } = layoutPicks(boxes, badges, { width: f.width, focusId: focusRef.current });
    for (const [id, ov] of overlays.current) {
      const pin = ov.getContent() as HTMLElement;
      const want = hide.has(id);
      if (pin.classList.contains("pin--nolabel") !== want) pin.classList.toggle("pin--nolabel", want);
    }
    // 가로로 민 양: 이번에 민 핀은 값을 쓰고, 전에 밀었던 핀은 지운다
    for (const id of shifted.current) {
      if (shift.get(id)) continue;
      (overlays.current.get(id)?.getContent() as HTMLElement | undefined)?.style.removeProperty("--label-dx");
      shifted.current.delete(id);
    }
    for (const [id, dx] of shift) {
      if (!dx) continue;
      const pin = overlays.current.get(id)?.getContent() as HTMLElement | undefined;
      const v = `${Math.round(dx)}px`;
      if (pin && pin.style.getPropertyValue("--label-dx") !== v) pin.style.setProperty("--label-dx", v);
      shifted.current.add(id);
    }
    // 쌓는 순서: 위부터 10, 9, 8 (펼친 후보가 맨 위면 12)
    order.forEach((id, i) => overlays.current.get(id)?.setZIndex(i === 0 && id === focusRef.current ? 12 : 10 - i));
    // 칩이 피할 상자: 보이는 이름표(펼친 후보가 있으면 그것만, 민 자리)와 번호 배지
    const focus = focusRef.current;
    const obstacles: LabelBox[] = [...badges];
    for (const b of boxes) {
      const visible = focus ? b.id === focus : !hide.has(b.id);
      if (visible) obstacles.push({ ...b, x: b.x + (shift.get(b.id) ?? 0) });
    }
    // 뽑히지 않은 선택 핀의 이름표 (.pin--selected::after)
    const sel = selectedRef.current;
    const selOv = sel && !picksRef.current.includes(sel) ? overlays.current.get(sel) : undefined;
    if (selOv) {
      const pt = proj.containerPointFromCoords(selOv.getPosition());
      const name = (selOv.getContent() as HTMLElement).dataset.name ?? "";
      obstacles.push(pickLabelBox(sel!, { x: pt.x, y: pt.y }, labelTextWidth(name, font)));
    }
    pickObstacles.current = obstacles;
  };

  // R28: 가까이(near, mid는 평점 높은 곳·선택만) 본 지도에서 서로 덮는 평점 칩은 평점·리뷰 순으로 하나만 남기고 나머지는 점으로 그린다.
  // 화면 안 핀만 보고(위경도로 먼저 거른 뒤 투영, shared/labels.ts keptChips, 격자 칸), 바뀐 핀의 클래스만 건드린다. 걸린 시간은 performance 측정 "mmj:chips"
  layoutChips.current = (f = readFrame()) => {
    const m = map.current;
    if (!m || !f || typeof m.getProjection !== "function") return;
    const t0 = performance.now();
    const z = zoomOf(m.getLevel());
    const want = new Map<string, boolean>();
    if (z !== "far") {
      const proj = m.getProjection();
      const { width: W, height: H, font } = f;
      // 보이는 영역(+ CHIP_MARGIN)의 위경도로 먼저 걸러서 화면 밖 핀은 투영(containerPointFromCoords)하지 않는다
      let south = -Infinity, north = Infinity, west = -Infinity, east = Infinity;
      const bounds = typeof m.getBounds === "function" ? m.getBounds() : null;
      if (bounds && W > 0 && H > 0) {
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const dLat = ((ne.getLat() - sw.getLat()) / H) * CHIP_MARGIN;
        const dLng = ((ne.getLng() - sw.getLng()) / W) * CHIP_MARGIN;
        south = sw.getLat() - dLat;
        north = ne.getLat() + dLat;
        west = sw.getLng() - dLng;
        east = ne.getLng() + dLng;
      }
      const picked = new Set(picksRef.current);
      const sel = selectedRef.current;
      const chips: ChipBox[] = [];
      for (const [id, ov] of overlays.current) {
        if (picked.has(id)) continue;
        const p = placesRef.current.get(id);
        if (!p) continue;
        const rating = p.detail?.rating ?? null;
        const selected = id === sel;
        if (z === "mid" && !selected && (rating ?? 0) < TOP_RATING) continue;
        const pos = ov.getPosition();
        const lat = pos.getLat();
        const lng = pos.getLng();
        if (lat < south || lat > north || lng < west || lng > east) continue;
        const pt = proj.containerPointFromCoords(pos);
        if (pt.x < -CHIP_MARGIN || pt.x > W + CHIP_MARGIN || pt.y < -40 || pt.y > H + 40) continue;
        // .pin-chip: 좌우 여백 7(선택 9) + 테두리 1, 높이 16 + 위아래 2(선택 3) + 테두리 1
        const w = chipTextWidth(chipText(p), selected ? 12 : 11, font) + (selected ? 20 : 16);
        const h = selected ? 24 : 22;
        chips.push({ id, x: pt.x - w / 2, y: pt.y - h / 2, w, h, rating, reviews: p.detail?.reviewCount ?? null, pinned: selected });
      }
      const kept = keptChips(chips, pickObstacles.current);
      for (const c of chips) want.set(c.id, !kept.has(c.id));
    }
    // 멀리서 보면 모두 점이라 표시를 지운다. 화면 밖 핀은 다음 계산까지 그대로 둔다
    for (const id of noChip.current) if (!want.has(id) && (z === "far" || picksRef.current.includes(id))) want.set(id, false);
    // 기억해 둔 집합이 아니라 지금 핀의 클래스와 비교한다 (다시 만든 핀은 클래스가 없다, layoutLabels의 pin--nolabel과 같게)
    const pinOf = (id: string) => overlays.current.get(id)?.getContent() as HTMLElement | undefined;
    for (const [id, on] of chipToggles(want, (id) => pinOf(id)?.classList.contains("pin--nochip"))) {
      pinOf(id)!.classList.toggle("pin--nochip", on);
    }
    for (const [id, on] of want) {
      if (on && overlays.current.has(id)) noChip.current.add(id);
      else noChip.current.delete(id);
    }
    performance.clearMeasures?.("mmj:chips");
    performance.measure?.("mmj:chips", { start: t0 });
  };

  // 후보 핀: 바뀐 것만 붙이고 뗀다
  useEffect(() => {
    if (!ready) return;
    const kakao = window.kakao;
    const existing = overlays.current;
    const wanted = new Set(places.map((p) => p.id));
    for (const [id, ov] of existing) {
      if (!wanted.has(id)) {
        ov.setMap(null);
        existing.delete(id);
        // 다시 만들면 새 버튼이라 예전 표시(점, 민 이름표)를 기억하지 않는다
        noChip.current.delete(id);
        shifted.current.delete(id);
      }
    }
    for (const p of places) {
      let ov = existing.get(p.id);
      if (!ov) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "pin";
        // 핀은 지도 위 보조 수단이라 탭 순서에서 뺀다 (같은 가게는 목록에서 키보드로 고를 수 있다)
        btn.tabIndex = -1;
        btn.dataset.name = p.name;
        btn.setAttribute("aria-label", p.name);
        const chip = document.createElement("span");
        chip.className = "pin-chip";
        chip.setAttribute("aria-hidden", "true");
        btn.appendChild(chip);
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          handlers.current.onSelect(p.id);
        });
        ov = new kakao.maps.CustomOverlay({
          position: new kakao.maps.LatLng(p.lat, p.lng),
          content: btn,
          clickable: true,
          zIndex: 1,
        });
        ov.setMap(map.current);
        existing.set(p.id, ov);
      }
      const selected = p.id === selectedId;
      const rank = picks.indexOf(p.id) + 1;
      const focus = rank > 0 && p.id === focusId;
      const top = (p.detail?.rating ?? 0) >= TOP_RATING;
      const node = ov.getContent() as HTMLElement;
      // 바뀐 것만 건드린다. 클래스가 새로 붙을 때만 펄스 애니메이션이 돈다
      const want: Record<string, boolean> = {
        "pin--selected": selected,
        "pin--pick": rank > 0,
        "pin--focus": focus,
        "pin--top": top,
      };
      for (const [cls, on] of Object.entries(want)) {
        if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on);
      }
      const rankText = rank > 0 ? String(rank) : "";
      if ((node.dataset.rank ?? "") !== rankText) {
        if (rankText) node.dataset.rank = rankText;
        else delete node.dataset.rank;
      }
      const text = chipText(p);
      const chip = node.firstChild as HTMLElement;
      if (chip.textContent !== text) chip.textContent = text;
      ov.setZIndex(focus || selected ? 12 : rank > 0 ? 11 - rank : top ? 2 : 1);
    }
    picksRef.current = picks;
    focusRef.current = focusId;
    selectedRef.current = selectedId;
    placesRef.current = new Map(places.map((p) => [p.id, p]));
    relayoutPins();
  }, [ready, places, selectedId, picks, focusId]);

  // R22′: 새 후보가 뽑히면 먼저 3곳이 다 보이게 맞춘다
  const picksKey = picks.join(",");
  useEffect(() => {
    if (!ready || !picksKey) return;
    const kakao = window.kakao;
    const pts = picksKey
      .split(",")
      .map((id) => overlays.current.get(id))
      .filter(Boolean)
      .map((ov) => ov.getPosition());
    if (pts.length === 0) return;
    const m = map.current;
    if (pts.length === 1) {
      m.panTo(pts[0]);
      return;
    }
    const bounds = new kakao.maps.LatLngBounds();
    for (const pt of pts) bounds.extend(pt);
    // 위: 이름표 자리. 결과 시트가 지도를 가리는 만큼(모바일은 아래, 데스크톱은 왼쪽) 여백을 더 둔다
    let bottom = FIT_PAD;
    let left = FIT_PAD;
    const node = el.current;
    const sheet = node?.closest(".map-wrap")?.querySelector<HTMLElement>(".sheet");
    if (node && sheet) {
      const mr = node.getBoundingClientRect();
      const sr = sheet.getBoundingClientRect();
      if (isDesktop()) left = Math.max(FIT_PAD, sr.right - mr.left + 24);
      else bottom = Math.max(FIT_PAD, mr.bottom - sr.top + 24);
    }
    m.setBounds(bounds, 56, FIT_PAD, bottom, left);
    if (m.getLevel() < MIN_FIT_LEVEL) m.setLevel(MIN_FIT_LEVEL);
    layoutLabels.current();
    // places가 바뀔 때마다(폴링)가 아니라 새로 뽑혔을 때만 맞춘다
  }, [ready, picksKey]);

  // 펼친 후보로 이동
  useEffect(() => {
    if (!ready || !focusId) return;
    const ov = overlays.current.get(focusId);
    if (ov) map.current.panTo(ov.getPosition());
  }, [ready, focusId]);

  // 선택이 바뀌면 그 핀으로 이동 (모바일에서 뽑은 뒤 지도가 결과를 따라간다)
  useEffect(() => {
    if (!ready || !selectedId) return;
    const ov = overlays.current.get(selectedId);
    if (ov) map.current.panTo(ov.getPosition());
  }, [ready, selectedId]);

  return (
    <>
      {/* 지도 컨테이너의 class는 SDK 몫이라 건드리지 않고, 핀 모양 전환 data-zoom은 감싸는 요소에 둔다 */}
      <div className="map-zoom" data-zoom={zoom} data-focus={focusId ? "1" : undefined}>
        <div ref={el} className="map" />
      </div>
      {failed && (
        <div className="map-fallback">
          <p>지도를 불러오지 못했어요</p>
          <button
            type="button"
            className="btn-tint neutral"
            onClick={() => {
              setFailed(false);
              setAttempt((a) => a + 1);
            }}
          >
            다시 시도
          </button>
        </div>
      )}
    </>
  );
}
