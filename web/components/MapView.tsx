import { useEffect, useRef, useState } from "react";
import type { ApiPlace, LatLng } from "../../shared/types";
import { loadKakaoMaps } from "../kakaoLoader";

const ACCENT = "#ff6b3d";
/** 핀 탭 직후 지도 click이 새어 들어와도 기준점 찍기로 처리하지 않는 시간 */
const PIN_TAP_GUARD_MS = 400;

type Props = {
  center: LatLng;
  radius: number;
  places: ApiPlace[];
  selectedId: string | null;
  pickMode: boolean;
  onPick: (c: LatLng) => void;
  onSelect: (id: string) => void;
};

const hasSize = (node: HTMLElement) => node.clientWidth > 0 && node.clientHeight > 0;

/** R28: 기준점 핀, 반경 원(점선), 후보 핀(CustomOverlay 버튼). 선택된 핀은 커지고 한 번 퍼진다. */
export function MapView({ center, radius, places, selectedId, pickMode, onPick, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(undefined);
  const circle = useRef<any>(undefined);
  const centerPin = useRef<any>(undefined);
  const overlays = useRef(new Map<string, any>());
  const lastPinTap = useRef(0);
  const needsFit = useRef(true);
  const handlers = useRef({ pickMode, onPick, onSelect });
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // SDK 이벤트 리스너는 한 번만 등록하므로 최신 콜백은 ref로 읽는다
  useEffect(() => {
    handlers.current = { pickMode, onPick, onSelect };
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
        kakao.maps.event.addListener(m, "click", (e: any) => {
          if (Date.now() - lastPinTap.current < PIN_TAP_GUARD_MS) return;
          if (handlers.current.pickMode) handlers.current.onPick({ lat: e.latLng.getLat(), lng: e.latLng.getLng() });
        });
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

  // 기준점, 반경 변경
  useEffect(() => {
    if (!ready) return;
    const pos = new window.kakao.maps.LatLng(center.lat, center.lng);
    circle.current.setPosition(pos);
    circle.current.setRadius(radius);
    centerPin.current.setPosition(pos);
    fitCircle();
  }, [ready, center.lat, center.lng, radius]);

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
        btn.dataset.name = p.name;
        btn.setAttribute("aria-label", p.name);
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          lastPinTap.current = Date.now();
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
      const node = ov.getContent() as HTMLElement;
      // 클래스가 새로 붙을 때만 펄스 애니메이션이 돈다
      if (node.classList.contains("pin--selected") !== selected) node.classList.toggle("pin--selected", selected);
      ov.setZIndex(selected ? 10 : 1);
    }
  }, [ready, places, selectedId]);

  // 선택이 바뀌면 그 핀으로 이동 (모바일에서 뽑은 뒤 지도가 결과를 따라간다)
  useEffect(() => {
    if (!ready || !selectedId) return;
    const ov = overlays.current.get(selectedId);
    if (ov) map.current.panTo(ov.getPosition());
  }, [ready, selectedId]);

  useEffect(() => {
    if (ready) map.current.setCursor(pickMode ? "crosshair" : "");
  }, [ready, pickMode]);

  return (
    <>
      <div ref={el} className="map" />
      {failed && (
        <div className="map-fallback">
          <p>지도를 불러오지 못했어요</p>
          <button
            type="button"
            className="btn-ghost"
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

export function PickHint({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="pick-hint" role="status">
      <span>지도에서 기준점을 눌러주세요</span>
      <button type="button" onClick={onCancel}>
        취소
      </button>
    </div>
  );
}
