import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { shouldAutoDraw } from "../shared/autoDraw";
import { haversine, walkMinutes } from "../shared/geo";
import { hubById } from "../shared/hubs";
import { kstDay } from "../shared/kst";
import { topPercents } from "../shared/rank";
import { TRIO_SIZE, drawTrio, filterPlaces, relaxNotice, relaxToFill, sortPlaces, type Filters } from "../shared/recommend";
import { shareText } from "../shared/share";
import type { ApiDetail, ApiPlace, LatLng } from "../shared/types";
import { filterProps, setTrackingHub, startTracking, track, trackFilters } from "./analytics";
import { fetchPlace } from "./api";
import { autoDrawOffDay, autoDrawnThisSession, markAutoDrawn, turnOffAutoDraw, useInteracted } from "./autoDraw";
import { EmptyState, ErrorState } from "./components/EmptyState";
import { FilterPanel } from "./components/FilterPanel";
import { FirstTip, useFirstTip } from "./components/FirstTip";
import { HubChip } from "./components/HubChip";
import { MapView } from "./components/MapView";
import { warmPoses } from "./components/Mascot";
import { PlaceCard } from "./components/PlaceCard";
import { PlaceList } from "./components/PlaceList";
import { SkeletonList } from "./components/Skeleton";
import { StatusLine } from "./components/StatusLine";
import { Toast, useToast } from "./components/Toast";
import { TrioSheet } from "./components/TrioSheet";
import { statusOf } from "./format";
import { usePersonal } from "./personal";
import { shareOrCopy } from "./shareAction";
import { usePlaces } from "./usePlaces";
import { useSettings } from "./useSettings";
import { useSlotShuffle } from "./useSlotShuffle";

/** R13 응답에는 거리가 없어서 현재 거점으로 채운다 (R26) */
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

/**
 * R22′: 지금 보여주는 후보 3곳. 객체는 목록에 없을 때(공유받은 곳 등)를 위한 대비값이고, 화면은 최신 목록 객체를 우선한다.
 * outside: R41 완화로 들어온 곳
 */
type Trio = { ids: string[]; source: "drawn" | "received"; fallback: Record<string, ApiPlace>; outside?: ReadonlySet<string> };

const byId = (ps: ApiPlace[]) => Object.fromEntries(ps.map((p) => [p.id, p]));

export default function App() {
  const { settings, share, update } = useSettings();
  const { filters } = settings;
  const hub = hubById(settings.hubId);
  const center = useMemo<LatLng>(() => ({ lat: hub.lat, lng: hub.lng }), [hub.lat, hub.lng]);
  const { data, loading, error, polling, reload } = usePlaces(hub.id);
  const now = useNow();
  const personal = usePersonal();
  const { isExcluded, record } = personal;
  const [trio, setTrio] = useState<Trio | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  /** 목록·핀에서 연 한 곳 (뽑기 결과 위에 잠깐 겹쳐 연다) */
  const [selected, setSelected] = useState<ApiPlace | null>(null);
  const [receivedSingle, setReceivedSingle] = useState<string | null>(null);
  const drawnIds = useRef(new Set<string>());
  const shareCtrl = useRef<AbortController | null>(null);
  const shuffle = useSlotShuffle();
  const toast = useToast();
  const tip = useFirstTip();
  // R39: 재방문자 = 처음 열 때 첫 방문 안내가 닫혀 있었거나 개인화 신호가 있음
  const [returning] = useState(() => !tip.open || personal.hasSignals);
  const interacted = useInteracted();
  /** 지금 떠 있는 결과가 자동 뽑기로 뜬 것인가 (닫으면 그날은 끈다) */
  const autoTrio = useRef(false);

  // R35: 세션 시작(app_open)과 이벤트에 붙일 거점. 공유 링크의 거점이 적용된 뒤의 값이다
  const openTracked = useRef(false);
  useEffect(() => {
    setTrackingHub(hub.id);
    if (openTracked.current) return;
    openTracked.current = true;
    startTracking(hub.id, { radius: filters.radius, party: filters.party });
  }, [hub.id, filters.radius, filters.party]);

  // R37: "여긴 빼줘"한 곳은 후보(목록·지도·뽑기)에 나오지 않는다
  const candidates = useMemo(
    () =>
      sortPlaces(filterPlaces(data?.places ?? [], filters, now), filters.sort).filter((p) => !isExcluded(p.id)),
    [data, filters, now, isExcluded],
  );
  // R41: 후보가 3곳보다 적으면 덜 중요한 조건부터 풀어 뽑을 곳을 채운다 (목록은 원래 조건 그대로)
  const relax = useMemo(
    () => relaxToFill(data?.places ?? [], filters, now, { keep: (p) => !isExcluded(p.id) }),
    [data, filters, now, isExcluded],
  );
  // R34: 필터 전 전체 목록(지금 거점·반경) 기준 평점 상위 N%. R42: 1000m 목록 중 화면 반경 안에서 매긴다
  const ranks = useMemo(() => topPercents(data?.places ?? [], filters.radius), [data, filters.radius]);

  // R13: 목록 응답에는 메뉴가 3개뿐이라 카드를 열면 단건 조회로 전체 상세를 한 번 받아 합친다
  const [fullDetails, setFullDetails] = useState<Record<string, ApiDetail>>({});
  const [detailPending, setDetailPending] = useState<string | null>(null);
  const detailId = selected?.id ?? focusId;
  const haveFull = detailId === null || detailId in fullDetails;
  useEffect(() => {
    if (detailId === null || haveFull) return;
    // 다른 카드로 바뀌면 이전 요청은 버린다
    const ctrl = new AbortController();
    setDetailPending(detailId);
    fetchPlace(detailId, ctrl.signal)
      .then((p) => {
        setDetailPending(null);
        const detail = p.detail;
        if (detail) setFullDetails((m) => ({ ...m, [p.id]: detail }));
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setDetailPending(null);
      });
    return () => ctrl.abort();
  }, [detailId, haveFull]);

  // 폴링으로 목록이 바뀌면 최신 객체를 쓰고, 받아 둔 전체 상세와 현재 거점 기준 도보 시간을 붙인다
  const latest = useMemo(() => new Map((data?.places ?? []).map((p) => [p.id, p])), [data]);
  const resolve = useCallback(
    (p: ApiPlace) => {
      const base = latest.get(p.id) ?? p;
      const full = fullDetails[p.id];
      return withWalk(full ? { ...base, detail: full } : base, center);
    },
    [latest, fullDetails, center],
  );
  const trioPlaces = useMemo(
    () =>
      trio
        ? trio.ids
            // 공유받은 후보는 친구가 고른 곳이라 빼둔 곳이어도 보여준다
            .filter((id) => trio.source === "received" || !isExcluded(id))
            .map((id) => resolve(trio.fallback[id]))
        : [],
    [trio, isExcluded, resolve],
  );
  const cardPlace = useMemo(() => (selected ? resolve(selected) : null), [selected, resolve]);
  // 지도에는 후보만 찍되, 후보 밖의 결과(공유받은 곳 등)도 보이게 한다
  const mapPlaces = useMemo(() => {
    const extra = [...trioPlaces, ...(cardPlace ? [cardPlace] : [])].filter(
      (p, i, all) => !candidates.some((c) => c.id === p.id) && all.findIndex((q) => q.id === p.id) === i,
    );
    return extra.length > 0 ? [...candidates, ...extra] : candidates;
  }, [candidates, trioPlaces, cardPlace]);
  const picks = useMemo(() => trioPlaces.map((p) => p.id), [trioPlaces]);

  // 뽑기·공유 뒤에 뜨는 마스코트는 첫 응답이 오면 미리 받아둔다
  const hasData = data !== null;
  useEffect(() => {
    if (hasData) warmPoses(["search", "thumbsup", "love"]);
  }, [hasData]);

  // R23′: 공유 링크의 가게는 목록과 상관없이 바로 id로 받아 온다 (목록이 실패해도 보여준다)
  const shareStarted = useRef(false);
  const { show: showToast } = toast;
  useEffect(() => {
    const ids = share.placeIds;
    if (shareStarted.current || ids.length === 0) return;
    shareStarted.current = true;
    track("share_open", { props: { picks: ids.slice(0, TRIO_SIZE) } });
    const ctrl = new AbortController();
    shareCtrl.current = ctrl;
    void Promise.allSettled(ids.map((id) => fetchPlace(id, ctrl.signal))).then((results) => {
      if (ctrl.signal.aborted) return;
      const found = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (found.length === 0) {
        showToast("공유된 가게를 찾지 못했어요");
        return;
      }
      setFullDetails((m) => {
        const next = { ...m };
        for (const p of found) if (p.detail) next[p.id] = p.detail;
        return next;
      });
      record("received", found);
      if (ids.length === 1) {
        setReceivedSingle(found[0].id);
        setSelected(found[0]);
      } else {
        setTrio({ ids: found.map((p) => p.id), source: "received", fallback: byId(found) });
      }
      const missing = ids.length - found.length;
      if (missing > 0) showToast(`${missing}곳은 찾지 못했어요`);
    });
  }, [share.placeIds, showToast, record]);

  /** 거점·반경이 바뀌면 진행 중인 셔플과 공유 불러오기를 멈추고 결과를 비운다 (QA S-3) */
  const clearTrio = () => {
    shuffle.cancel();
    shareCtrl.current?.abort();
    drawnIds.current.clear();
    setTrio(null);
    setFocusId(null);
  };
  /** R35: 필터를 바꾼 뒤 후보가 0곳이 되면 empty_result를 한 번 남긴다 */
  const filterChanged = useRef(false);
  const setFilters = (f: Filters) => {
    if (f.radius !== filters.radius) clearTrio();
    update((s) => ({ ...s, filters: f }));
    // 정렬만 바꾼 것은 필터 변경으로 치지 않는다
    if (JSON.stringify(filterProps(f)) !== JSON.stringify(filterProps(filters))) {
      filterChanged.current = true;
      trackFilters(f);
    }
  };
  const setHub = (hubId: string) => {
    clearTrio();
    update((s) => ({ ...s, hubId }));
    setSelected(null);
    if (hubId !== hub.id) {
      setTrackingHub(hubId);
      track("hub_change");
    }
  };
  const closeTrio = () => {
    if (shuffle.running) return;
    if (autoTrio.current) {
      autoTrio.current = false;
      turnOffAutoDraw(kstDay(Date.now()));
    }
    setTrio(null);
    setFocusId(null);
  };
  const closeCard = () => setSelected(null);

  // R21′/R22′: 3곳 가중 뽑기 → 0.8초 셔플 → 카드 3장 + 지도 번호 + 짧은 진동.
  // R39 자동 뽑기(auto)는 shown 신호를 남기지 않고 첫 방문 안내도 닫지 않는다
  const onDraw = ({ auto = false }: { auto?: boolean } = {}) => {
    if (shuffle.running) return;
    if (tip.open && !auto) tip.dismiss();
    // 아직 오는 중인 공유 링크 결과가 방금 뽑은 결과를 덮어쓰지 않게 한다
    shareCtrl.current?.abort();
    if (!data) {
      toast.show("가게 정보를 불러오는 중이에요");
      return;
    }
    const kind = trio?.source === "drawn" ? "redraw" : "draw";
    const extra = relax.extra;
    const pool = candidates.length + extra.length;
    const r = drawTrio(candidates, filters.party, drawnIds.current, Math.random, {
      multiplier: personal.multiplier(Date.now()),
      extra,
    });
    if (!r) {
      setTrio(null);
      setFocusId(null);
      setSelected(null);
      toast.show("조건에 맞는 곳이 없어요");
      document.getElementById("empty")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    // R41: 완화로 들어온 곳이 결과에 있으면 무엇을 풀었는지 한 줄로 알린다
    const outside = new Set(r.places.filter((p) => extra.includes(p)).map((p) => p.id));
    const notice = outside.size > 0 ? relaxNotice(relax.relaxed, relax.addedRadius) : null;
    if (r.reset) {
      drawnIds.current.clear();
      if (!notice) {
        toast.show(pool <= TRIO_SIZE ? `조건에 맞는 곳이 ${pool}곳뿐이에요` : "후보를 다 돌아서 처음부터 다시 뽑아요");
      }
    }
    if (notice) toast.show(notice);
    setSelected(null);
    setTrio(null);
    setFocusId(null);
    autoTrio.current = auto;
    shuffle.run(
      [...candidates, ...extra].map((c) => c.name),
      () => {
        for (const p of r.places) drawnIds.current.add(p.id);
        setTrio({ ids: r.places.map((p) => p.id), source: "drawn", fallback: byId(r.places), outside });
        if (!auto) record("shown", r.places);
        track(kind, {
          props: {
            candidates: pool, picks: r.places.map((p) => p.id), radius: filters.radius, party: filters.party,
            ...(auto ? { auto: true as const } : {}),
          },
        });
        navigator.vibrate?.(15);
      },
    );
  };

  // R39: 재방문자는 목록이 오면 한 번 자동으로 뽑는다 (사용자가 아직 아무것도 누르지 않았을 때만)
  const autoPool = candidates.length + relax.extra.length;
  const autoDone = useRef(false);
  useEffect(() => {
    if (autoDone.current || interacted.current) return;
    const go = shouldAutoDraw({
      returning,
      shareLink: share.placeIds.length > 0,
      drawnThisSession: autoDrawnThisSession(),
      interacted: interacted.current,
      offDay: autoDrawOffDay(),
      today: kstDay(Date.now()),
      hasData,
      pool: autoPool,
    });
    if (!go) return;
    autoDone.current = true;
    markAutoDrawn();
    onDraw({ auto: true });
    // onDraw는 매 렌더 새로 만들어지지만, 목록이 처음 준비됐을 때 한 번만 부르면 된다
  }, [hasData, autoPool, returning, share.placeIds]);

  // 셔플 중에는 목록·핀 선택을 받지 않는다 (M2). 결과 3곳 중 하나면 그 카드를 펼친다
  const onSelect = (p: ApiPlace) => {
    if (shuffle.running) return;
    track("select_place", { placeId: p.id });
    if (picks.includes(p.id)) {
      setSelected(null);
      setFocusId(p.id);
      return;
    }
    setSelected(p);
  };

  // R23′: 폰은 시스템 공유 시트, 아니면 클립보드 복사. 공유한 곳은 R37 신호로 남긴다
  const onShare = async (ps: ApiPlace[]) => {
    const outcome = await shareOrCopy(shareText(ps, filters, hub.id, window.location.origin));
    if (outcome === "shared" || outcome === "copied") {
      record("shared", ps);
      track("share", { props: { picks: ps.slice(0, TRIO_SIZE).map((p) => p.id) } });
    }
    if (outcome === "shared") toast.show("공유했어요", "love");
    else if (outcome === "copied") toast.show("복사했어요", "love");
    else if (outcome === "failed") toast.show("복사하지 못했어요");
  };
  /** 결과 3곳 중 몇 번째 카드인지 (아니면 없음) */
  const rankOf = (id: string) => {
    const i = picks.indexOf(id);
    return i >= 0 ? { rank: i + 1 } : undefined;
  };
  const onKakao = (p: ApiPlace) => {
    record("kakao_open", [p]);
    track("open_kakao", { placeId: p.id, props: rankOf(p.id) });
  };
  const onFocus = (id: string | null) => {
    if (id !== null) track("expand_card", { placeId: id, props: rankOf(id) });
    setFocusId(id);
  };
  // R37: "여긴 빼줘" → 되돌리기 5초
  const onExclude = (p: ApiPlace) => {
    track("exclude_place", { placeId: p.id, props: rankOf(p.id) });
    personal.exclude(p.id);
    setFocusId(null);
    // 받은 후보는 친구가 고른 곳이라 카드는 그대로 두고, 다음 뽑기부터만 뺀다
    toast.show(trio?.source === "received" ? "다음 뽑기부터 빼둘게요" : "다음부터 빼고 골라요", undefined, {
      ms: 8000,
      action: {
        label: "되돌리기",
        onClick: () => {
          personal.include(p.id);
          track("undo_exclude", { placeId: p.id });
        },
      },
    });
  };

  // R35: 필터를 바꾼 뒤(다시 불러오기가 끝난 상태에서) 후보가 0곳이면 한 번 남긴다
  const settled = data !== null && !loading && !polling;
  const empty = candidates.length === 0;
  useEffect(() => {
    if (!settled || !filterChanged.current) return;
    filterChanged.current = false;
    if (empty) track("empty_result", { props: { ...filterProps(filters), candidates: 0 } });
  }, [settled, empty, filters]);

  const status = statusOf(data, polling, error, now.getTime());
  const trioOpen = selected === null && (shuffle.display !== null || trioPlaces.length > 0);
  const drawLabel = shuffle.running ? "고르는 중…" : trio?.source === "drawn" ? "다시 뽑기" : "모먹죠?";

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
        selectedId={selected?.id ?? focusId}
        ranks={ranks}
        sort={filters.sort}
        now={now}
        dim={loading}
        onSort={(sort) => setFilters({ ...filters, sort })}
        onSelect={onSelect}
      />
    );
  }

  return (
    <div className={`app${trioOpen || cardPlace ? " has-sheet" : ""}`}>
      <header className="topbar">
        <h1 className="logo">
          <img src="/brand/logo.png" alt="모먹죠" width={63} height={28} draggable={false} />
        </h1>
        <HubChip hub={hub} onChange={setHub} />
      </header>
      <main className="main">
        <section className="map-wrap">
          <MapView
            center={center}
            radius={filters.radius}
            places={mapPlaces}
            selectedId={selected?.id ?? null}
            picks={picks}
            focusId={selected ? null : focusId}
            onSelect={(id) => {
              const p = mapPlaces.find((x) => x.id === id);
              if (p) onSelect(p);
            }}
          />
          {cardPlace && (
            <PlaceCard
              key={cardPlace.id}
              place={cardPlace}
              eyebrow={cardPlace.id === receivedSingle ? "공유받은 곳" : undefined}
              topPercent={ranks.get(cardPlace.id)}
              now={now}
              onClose={closeCard}
              onShare={(p) => onShare([p])}
              onKakao={onKakao}
            />
          )}
          {trioOpen && (
            <TrioSheet
              slotName={shuffle.display}
              places={trioPlaces}
              received={trio?.source === "received"}
              focusId={focusId}
              detailLoading={detailPending !== null && detailPending === focusId}
              ranks={ranks}
              outside={trio?.outside}
              now={now}
              onFocus={onFocus}
              onClose={closeTrio}
              onShare={onShare}
              onKakao={onKakao}
              onExclude={onExclude}
            />
          )}
        </section>
        <aside className="panel">
          {tip.open && <FirstTip onClose={tip.dismiss} />}
          <FilterPanel filters={filters} onChange={setFilters} />
          {status && <StatusLine status={status} onRetry={error ? reload : undefined} />}
          {list}
          <div className="draw-bar">
            <button
              type="button"
              className={`draw${trioOpen && !shuffle.running ? " is-secondary" : ""}`}
              aria-busy={shuffle.running}
              disabled={shuffle.running}
              onClick={() => onDraw()}
            >
              {drawLabel}
            </button>
          </div>
        </aside>
      </main>
      <Toast msg={toast.msg} onAction={toast.hide} onPause={toast.pause} onResume={toast.resume} />
    </div>
  );
}
