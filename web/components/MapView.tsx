import { useEffect, useRef, useState } from "react";
import { hiddenLabels, pickBadgeBox, pickLabelBox } from "../../shared/labels";
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

/** 이름표 글자 너비 (.pin--pick::after와 같은 12px 굵기 600). 캔버스 하나를 다시 쓴다 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function labelTextWidth(text: string, fontFamily: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 12;
  measureCtx.font = `600 12px ${fontFamily}`;
  return measureCtx.measureText(text).width;
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
  const layoutLabels = useRef(() => {});
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 확대 수준에 따라 핀 모양만 CSS로 바꾼다 (오버레이는 다시 만들지 않는다)
  const [zoom, setZoom] = useState<Zoom>("far");

  // SDK 이벤트 리스너는 한 번만 등록하므로 최신 콜백은 ref로 읽는다
  useEffect(() => {
    handlers.current = { onSelect };
  });

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
        // 확대·이동이 끝나면 이름표 겹침을 다시 본다 (확대하면 떨어져서 다시 보일 수 있다)
        kakao.maps.event.addListener(m, "idle", () => layoutLabels.current());
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

  // R22′: 뽑힌 3곳의 이름표가 앞 번호의 이름표·배지와 겹치면 그 이름표를 숨긴다 (번호 배지는 남는다). 핀 좌표를 화면 px로 바꿔 상자를 비교한다
  layoutLabels.current = () => {
    const m = map.current;
    const node = el.current;
    if (!m || !node || typeof m.getProjection !== "function") return;
    const proj = m.getProjection();
    const font = getComputedStyle(node).fontFamily;
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
    // 앞 번호의 이름표나 번호 배지를 덮는 이름표를 숨긴다
    const hide = hiddenLabels(boxes, 2, badges);
    for (const [id, ov] of overlays.current) {
      const pin = ov.getContent() as HTMLElement;
      const want = hide.has(id);
      if (pin.classList.contains("pin--nolabel") !== want) pin.classList.toggle("pin--nolabel", want);
    }
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
    layoutLabels.current();
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
