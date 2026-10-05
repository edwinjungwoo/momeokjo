import { useMemo, useState } from "react";
import type { LatLng } from "../shared/types";
import { CenterChip } from "./components/CenterChip";
import { ErrorState } from "./components/EmptyState";
import { MapView, PickHint } from "./components/MapView";
import { SkeletonList } from "./components/Skeleton";
import { StatusLine } from "./components/StatusLine";
import { Toast, useToast } from "./components/Toast";
import { statusOf } from "./format";
import { usePlaces } from "./usePlaces";
import { useSettings } from "./useSettings";

// 임시 셸 (Task 16에서 전체 교체): 레이아웃, 지도, 기준점, 로딩 상태를 폰에서 먼저 확인한다
export default function App() {
  const { settings, update } = useSettings();
  const { center, filters } = settings;
  const { data, error, polling, reload } = usePlaces(center, filters.radius);
  const [pickMode, setPickMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const toast = useToast();
  const places = useMemo(
    () => (data?.places ?? []).filter((p) => (p.distance ?? Infinity) <= filters.radius),
    [data, filters.radius],
  );
  const setCenter = (c: LatLng) => update((s) => ({ ...s, center: c }));
  const status = statusOf(data, polling, error);

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="logo">
          모먹<span>죠</span>
        </h1>
        <CenterChip center={center} onCenter={setCenter} onPickStart={() => setPickMode(true)} onToast={toast.show} />
      </header>
      <main className="main">
        <section className="map-wrap">
          <MapView
            center={center}
            radius={filters.radius}
            places={places}
            selectedId={selectedId}
            pickMode={pickMode}
            onPick={(c) => {
              setPickMode(false);
              setCenter(c);
            }}
            onSelect={setSelectedId}
          />
          {pickMode && <PickHint onCancel={() => setPickMode(false)} />}
        </section>
        <aside className="panel">
          {status && <StatusLine status={status} onRetry={error ? reload : undefined} />}
          {!data ? (
            error ? <ErrorState onRetry={reload} /> : <SkeletonList label="주변 식당을 찾고 있어요" />
          ) : (
            <h2 className="list-title">
              반경 안 가게 <em>{places.length}</em>곳
            </h2>
          )}
          <div className="draw-bar">
            <button type="button" className="draw" onClick={() => toast.show("뽑기는 곧 열려요")}>
              🎲 모먹죠?
            </button>
          </div>
        </aside>
      </main>
      <Toast msg={toast.msg} />
    </div>
  );
}
