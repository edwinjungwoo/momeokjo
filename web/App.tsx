import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { haversine, walkMinutes } from "../shared/geo";
import { draw, filterPlaces, sortPlaces, type Filters } from "../shared/recommend";
import { shareText } from "../shared/share";
import type { ApiDetail, ApiPlace, LatLng } from "../shared/types";
import { fetchPlace } from "./api";
import { CenterChip } from "./components/CenterChip";
import { EmptyState, ErrorState } from "./components/EmptyState";
import { FilterPanel } from "./components/FilterPanel";
import { FirstTip, useFirstTip } from "./components/FirstTip";
import { MapView, PickHint } from "./components/MapView";
import { warmPoses } from "./components/Mascot";
import { PlaceCard } from "./components/PlaceCard";
import { PlaceList } from "./components/PlaceList";
import { SkeletonList } from "./components/Skeleton";
import { StatusLine } from "./components/StatusLine";
import { Toast, useToast } from "./components/Toast";
import { statusOf } from "./format";
import { shareOrCopy } from "./shareAction";
import { usePlaces } from "./usePlaces";
import { useSettings } from "./useSettings";
import { useSlotShuffle } from "./useSlotShuffle";

/** R13 응답에는 거리가 없어서 현재 기준점으로 채운다 (R26) */
function withWalk(p: ApiPlace, c: LatLng): ApiPlace {
  if (p.walkMinutes !== undefined) return p;
  const distance = Math.round(haversine(c, p));
  return { ...p, distance, walkMinutes: walkMinutes(distance) };
}

function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export default function App() {
  const { settings, share, update } = useSettings();
  const { filters, center } = settings;
  const { data, loading, error, polling, reload } = usePlaces(center, filters.radius);
  const now = useNow();
  const [selected, setSelected] = useState<ApiPlace | null>(null);
  const [drawn, setDrawn] = useState(false);
  const [pickMode, setPickMode] = useState(false);
  const drawnIds = useRef(new Set<string>());
  const shuffle = useSlotShuffle();
  const toast = useToast();
  const tip = useFirstTip();

  const candidates = useMemo(
    () => sortPlaces(filterPlaces(data?.places ?? [], filters, now), filters.sort),
    [data, filters, now],
  );
  // 지도에는 후보만 찍되, 후보 밖에서 연 가게(공유 링크 등)도 보이게 한다
  const mapPlaces = useMemo(
    () => (selected && !candidates.some((c) => c.id === selected.id) ? [...candidates, selected] : candidates),
    [candidates, selected],
  );

  // R13: 목록 응답에는 메뉴가 3개뿐이라 카드를 열면 단건 조회로 전체 상세를 한 번 받아 합친다
  const [fullDetails, setFullDetails] = useState<Record<string, ApiDetail>>({});
  const requestedFull = useRef(new Set<string>());
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (!selectedId || requestedFull.current.has(selectedId)) return;
    requestedFull.current.add(selectedId);
    fetchPlace(selectedId)
      .then((p) => {
        const detail = p.detail;
        if (detail) setFullDetails((m) => ({ ...m, [p.id]: detail }));
      })
      .catch(() => requestedFull.current.delete(selectedId));
  }, [selectedId]);
  const cardPlace = useMemo(() => {
    const full = selected ? fullDetails[selected.id] : undefined;
    return selected && full ? { ...selected, detail: full } : selected;
  }, [selected, fullDetails]);

  // 폴링으로 상세가 채워지면 열린 카드도 최신 객체로 바꾼다
  useEffect(() => {
    if (!data) return;
    setSelected((cur) => (cur ? (data.places.find((p) => p.id === cur.id) ?? cur) : cur));
  }, [data]);

  // 뽑기·공유 뒤에 뜨는 마스코트는 첫 응답이 오면 미리 받아둔다
  const hasData = data !== null;
  useEffect(() => {
    if (hasData) warmPoses(["search", "thumbsup", "love"]);
  }, [hasData]);

  // R23: 공유 링크로 들어오면 첫 응답 뒤 해당 가게 카드를 연다. 목록에 없으면 R13으로 가져온다.
  const shareHandled = useRef(false);
  const showToast = toast.show;
  useEffect(() => {
    const id = share.placeId;
    if (shareHandled.current || !id || !data) return;
    shareHandled.current = true;
    const found = data.places.find((p) => p.id === id);
    if (found) {
      setSelected(found);
      return;
    }
    requestedFull.current.add(id);
    fetchPlace(id)
      .then((p) => {
        const detail = p.detail;
        if (detail) setFullDetails((m) => ({ ...m, [p.id]: detail }));
        setSelected(withWalk(p, center));
      })
      .catch(() => showToast("공유된 가게를 찾지 못했어요"));
  }, [data, share.placeId, center, showToast]);

  const setFilters = (f: Filters) => update((s) => ({ ...s, filters: f }));
  const setCenter = (c: LatLng) => {
    update((s) => ({ ...s, center: c }));
    setSelected(null);
    setDrawn(false);
    drawnIds.current.clear();
  };
  const closeCard = () => {
    setSelected(null);
    setDrawn(false);
  };

  // R21/R22: 가중 뽑기 → 0.8초 셔플 → 카드 안착 + 지도 이동 + 짧은 진동
  const onDraw = () => {
    if (shuffle.running) return;
    if (tip.open) tip.dismiss();
    if (!data) {
      toast.show("가게 정보를 불러오는 중이에요");
      return;
    }
    const r = draw(candidates, filters.party, drawnIds.current, Math.random);
    if (!r) {
      closeCard();
      toast.show("조건에 맞는 곳이 없어요");
      document.getElementById("empty")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (r.reset) {
      drawnIds.current.clear();
      toast.show("후보를 다 돌아서 처음부터 다시 뽑아요");
    }
    drawnIds.current.add(r.place.id);
    setSelected(null);
    setDrawn(true);
    shuffle.run(
      candidates.map((c) => c.name),
      () => {
        setSelected(r.place);
        navigator.vibrate?.(15);
      },
    );
  };

  const onSelect = (p: ApiPlace) => {
    setSelected(p);
    setDrawn(false);
  };

  // R23: 폰은 시스템 공유 시트, 아니면 클립보드 복사
  const onShare = async (p: ApiPlace) => {
    const outcome = await shareOrCopy(shareText(p, filters, center, window.location.origin));
    if (outcome === "shared") toast.show("공유했어요", "love");
    else if (outcome === "copied") toast.show("복사했어요", "love");
    else if (outcome === "failed") toast.show("복사하지 못했어요");
  };

  const status = statusOf(data, polling, error);
  const sheetOpen = shuffle.display !== null || selected !== null;
  const drawLabel = shuffle.running ? "고르는 중…" : drawn && selected ? "다시 뽑기" : "모먹죠?";

  let list: ReactNode;
  if (!data) {
    list = error ? (
      <ErrorState onRetry={reload} />
    ) : (
      <SkeletonList title="맛있는 맛집을 찾고 있어요!" desc="조금만 기다려주세요" />
    );
  } else if (candidates.length === 0 && polling) {
    list = <SkeletonList title="주변 맛집 정보를 모으는 중이에요" desc="조금만 기다려주세요" />;
  } else if (candidates.length === 0) {
    list = <EmptyState filters={filters} onChange={setFilters} />;
  } else {
    list = (
      <PlaceList
        places={candidates}
        selectedId={selected?.id ?? null}
        sort={filters.sort}
        now={now}
        dim={loading}
        onSort={(sort) => setFilters({ ...filters, sort })}
        onSelect={onSelect}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">
          <img src="/brand/logo.png" alt="모먹죠" width={63} height={28} draggable={false} />
        </h1>
        <CenterChip center={center} onCenter={setCenter} onPickStart={() => setPickMode(true)} onToast={toast.show} />
      </header>
      <main className="main">
        <section className="map-wrap">
          <MapView
            center={center}
            radius={filters.radius}
            places={mapPlaces}
            selectedId={selected?.id ?? null}
            pickMode={pickMode}
            onPick={(c) => {
              setPickMode(false);
              setCenter(c);
            }}
            onSelect={(id) => {
              const p = mapPlaces.find((x) => x.id === id);
              if (p) onSelect(p);
            }}
          />
          {pickMode && <PickHint onCancel={() => setPickMode(false)} />}
          {sheetOpen && (
            <PlaceCard
              key={shuffle.display !== null ? "slot" : (selected?.id ?? "none")}
              place={cardPlace}
              slotName={shuffle.display}
              drawn={drawn}
              now={now}
              onClose={closeCard}
              onRedraw={onDraw}
              onShare={onShare}
            />
          )}
        </section>
        <aside className="panel">
          {tip.open && <FirstTip onClose={tip.dismiss} />}
          <FilterPanel filters={filters} onChange={setFilters} />
          {status && <StatusLine status={status} onRetry={error ? reload : undefined} />}
          {list}
          <div className="draw-bar">
            <button type="button" className="draw" aria-busy={shuffle.running} onClick={onDraw}>
              {drawLabel}
            </button>
          </div>
        </aside>
      </main>
      <Toast msg={toast.msg} />
    </div>
  );
}
