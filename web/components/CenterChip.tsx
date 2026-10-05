import { useEffect, useRef, useState } from "react";
import { ASEM } from "../../shared/constants";
import type { LatLng } from "../../shared/types";
import { Mascot } from "./Mascot";

const GEO_FAIL = "위치를 가져오지 못해서 ASEM 타워 기준으로 보여드려요";
const inKorea = (c: LatLng) => c.lat >= 33 && c.lat <= 39 && c.lng >= 124 && c.lng <= 132;
const isAsem = (c: LatLng) => Math.abs(c.lat - ASEM.lat) < 1e-6 && Math.abs(c.lng - ASEM.lng) < 1e-6;

type Props = {
  center: LatLng;
  onCenter: (c: LatLng) => void;
  onPickStart: () => void;
  onToast: (msg: string) => void;
};

/** R24: 기준점 칩 — 내 위치 / 지도에서 찍기 / ASEM 타워로 */
export function CenterChip({ center, onCenter, onPickStart, onToast }: Props) {
  const [open, setOpen] = useState(false);
  const [locating, setLocating] = useState(false);
  const [source, setSource] = useState<"me" | "other">("other");
  const root = useRef<HTMLDivElement>(null);
  // 지도에서 찍기를 시작한 시점의 기준점. 기준점이 이 값에서 바뀌어야 "선택한 위치"로 본다 (취소하면 그대로)
  const pickFrom = useRef<LatLng | null>(null);

  useEffect(() => {
    const from = pickFrom.current;
    if (from && (from.lat !== center.lat || from.lng !== center.lng)) {
      pickFrom.current = null;
      setSource("other");
    }
  }, [center]);

  // 메뉴 바깥을 누르거나 Esc를 누르면 닫는다
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const fallback = (msg: string) => {
    onCenter(ASEM);
    onToast(msg);
  };

  const locate = () => {
    if (!navigator.geolocation) return fallback(GEO_FAIL);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        if (!inKorea(c)) return fallback("국내에서만 쓸 수 있어서 ASEM 타워 기준으로 보여드려요");
        setSource("me");
        onCenter(c);
      },
      () => {
        setLocating(false);
        fallback(GEO_FAIL);
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  };

  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  const label = locating ? "위치 찾는 중…" : isAsem(center) ? "ASEM 타워" : source === "me" ? "내 위치" : "선택한 위치";

  return (
    <div className="center-chip" ref={root}>
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">📍</span>
        <span className="chip-label">{label}</span>
        <span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="어디서 찾을까요?">
          <div className="menu-head" aria-hidden="true">
            <Mascot pose="location" height={36} eager />
            <span>어디서 찾을까요?</span>
          </div>
          <button type="button" role="menuitem" onClick={choose(locate)}>
            내 위치
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={choose(() => {
              pickFrom.current = center;
              onPickStart();
            })}
          >
            지도에서 찍기
          </button>
          <button type="button" role="menuitem" onClick={choose(() => onCenter(ASEM))}>
            ASEM 타워로
          </button>
        </div>
      )}
    </div>
  );
}
