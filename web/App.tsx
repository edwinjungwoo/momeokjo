import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AUTO_DRAW_POLL_WAIT_MS, pollingElapsed, shouldAutoDraw } from "../shared/autoDraw";
import { haversine, walkMinutes } from "../shared/geo";
import { DEFAULT_HUB_ID, publicHubById } from "../shared/hubs";
import { kstDay } from "../shared/kst";
import { topPercents } from "../shared/rank";
import { trioReasons } from "../shared/reasons";
import type { Seen } from "../shared/seen";
import {
  TRIO_SIZE, drawTrio, filterPlaces, relaxNotice, relaxToFill, relaxedBy, sortPlaces, type Filters,
} from "../shared/recommend";
import { showHubPicker, urlAfterHubChange } from "../shared/settings";
import { excludeToastText, shareConfirmText, shareText, toParticle } from "../shared/share";
import { createTapGate } from "../shared/tapGate";
import type { ApiDetail, ApiPlace, LatLng } from "../shared/types";
import { filterProps, setTrackingHub, startTracking, track, trackFilters } from "./analytics";
import { fetchPlace } from "./api";
import { trackHubPicked } from "./onboarding";
import { autoDrawOffDay, autoDrawnThisSession, markAutoDrawn, turnOffAutoDraw, useInteracted } from "./autoDraw";
import { EmptyState, ErrorState } from "./components/EmptyState";
import { FilterPanel } from "./components/FilterPanel";
import { FirstTip, useFirstTip } from "./components/FirstTip";
import { HubChip } from "./components/HubChip";
import { HubPicker } from "./components/HubPicker";
import { MapView } from "./components/MapView";
import { warmPoses } from "./components/Mascot";
import { PlaceCard } from "./components/PlaceCard";
import { PlaceList } from "./components/PlaceList";
import { SkeletonList } from "./components/Skeleton";
import { StatusLine } from "./components/StatusLine";
import { Toast, useToast } from "./components/Toast";
import { TrioSheet } from "./components/TrioSheet";
import { refreshNote, statusOf } from "./format";
import { usePersonal } from "./personal";
import { recordSeen, seenSnapshot } from "./seen";
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
 * outside: R41 완화로 들어온 곳. seen: 이 결과를 띄우기 전의 본 곳 기억 (R46 "처음 보는 곳"은 이것으로만 판단한다)
 */
type Trio = {
  ids: string[]; source: "drawn" | "received"; fallback: Record<string, ApiPlace>; outside?: ReadonlySet<string>; seen: Seen;
};

/** R13 단건에서만 오는 것: 전체 상세(메뉴 전부), 전화(R49), 상세를 가져온 시각(R48) */
type Full = Pick<ApiPlace, "phone" | "fetchedAt"> & { detail: ApiDetail };
const fullOf = (p: ApiPlace): Full | null => (p.detail ? { detail: p.detail, phone: p.phone, fetchedAt: p.fetchedAt } : null);

const byId = (ps: ApiPlace[]) => Object.fromEntries(ps.map((p) => [p.id, p]));

export default function App() {
  const { settings, share, update, askHub, chooseHub } = useSettings();
  const { filters } = settings;
  const hub = publicHubById(settings.hubId);
  const center = useMemo<LatLng>(() => ({ lat: hub.lat, lng: hub.lng }), [hub.lat, hub.lng]);
  // R61: 첫 접속 거점을 아직 안 골랐으면(질문이 떠 있거나, 거점 없는 공유 링크라 받은 시트 뒤로 미뤘거나) 기본 거점 목록을 받지 않는다.
  // 고른 뒤 그 거점을 바로 받는다
  const { data, loading, error, polling, fromCache, reload } = usePlaces(hub.id, !askHub);
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
  /** R22: 뽑기 연타는 600ms에 한 번만 받는다 (셔플이 없는 경우 — 움직임 줄이기, 후보 1곳 — 에도 이벤트가 쏟아지지 않게) */
  const drawGate = useRef(createTapGate());
  const toast = useToast();
  const tip = useFirstTip();
  // R39: 재방문자 = 처음 열 때 첫 방문 안내가 닫혀 있었거나 개인화 신호가 있음
  const [returning] = useState(() => !tip.open || personal.hasSignals);
  const interacted = useInteracted();
  /** 지금 떠 있는 결과가 자동 뽑기로 뜬 것인가 (닫으면 그날은 끈다) */
  const autoTrio = useRef(false);

  // R35: 세션 시작(app_open)과 이벤트에 붙일 거점. 공유 링크의 거점이 적용된 뒤의 값이다.
  // R61: 첫 접속 거점 질문을 보일 거면 고른 뒤에 시작한다 (app_open이 고르기 전 기본 거점으로 남지 않게).
  // 거점 없는 공유 링크는 받은 곳(share_open)을 바로 세야 해서 지금 시작한다 (질문은 받은 시트 뒤에)
  const openTracked = useRef(false);
  const deferTracking = askHub && share.placeIds.length === 0;
  useEffect(() => {
    if (deferTracking) return;
    setTrackingHub(hub.id);
    if (openTracked.current) return;
    openTracked.current = true;
    startTracking(hub.id, { radius: filters.radius, party: filters.party });
  }, [hub.id, filters.radius, filters.party, deferTracking]);

  // R37: "다음부터 안 보기"한 곳은 후보(목록·지도·뽑기)에 나오지 않는다
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
  const [fullDetails, setFullDetails] = useState<Record<string, Full>>({});
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
        const full = fullOf(p);
        if (full) setFullDetails((m) => ({ ...m, [p.id]: full }));
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setDetailPending(null);
      });
    return () => ctrl.abort();
  }, [detailId, haveFull]);
  /** 결과 카드를 펼친다. 단건이 아직 없으면 같은 렌더에서 "받는 중"으로 둔다 — 첫 화면부터 R49 전화 자리를 잡아 두게 */
  const expand = (id: string | null) => {
    if (id !== null && !(id in fullDetails)) setDetailPending(id);
    setFocusId(id);
  };

  // 폴링으로 목록이 바뀌면 최신 객체를 쓰고, 받아 둔 전체 상세와 현재 거점 기준 도보 시간을 붙인다
  const latest = useMemo(() => new Map((data?.places ?? []).map((p) => [p.id, p])), [data]);
  const resolve = useCallback(
    (p: ApiPlace) => {
      const base = latest.get(p.id) ?? p;
      const full = fullDetails[p.id];
      return withWalk(full ? { ...base, ...full } : base, center);
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
  // R46: 보여주는 곳들 안에서 참인 "왜" 한 단어 (카드당 하나, "조건 밖" 카드는 없음)
  const reasons = useMemo(
    () => (trio ? trioReasons(trioPlaces, { seen: trio.seen, outside: trio.outside }) : []),
    [trio, trioPlaces],
  );
  // R46: 목록·핀에서 연 카드(공유받은 한 곳 포함)도 본 곳으로 기억한다
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId !== null) recordSeen([selectedId]);
  }, [selectedId]);

  // 뽑기·공유 뒤에 뜨는 마스코트는 첫 응답이 오면 미리 받아둔다
  const hasData = data !== null;
  useEffect(() => {
    if (hasData) warmPoses(["search", "thumbsup", "love"]);
  }, [hasData]);

  // R23′: 공유 링크의 가게는 목록과 상관없이 바로 id로 받아 온다 (목록이 실패해도 보여준다)
  const shareStarted = useRef(false);
  const [shareSettled, setShareSettled] = useState(false);
  const { show: showToast } = toast;
  useEffect(() => {
    const ids = share.placeIds;
    if (shareStarted.current || ids.length === 0) return;
    shareStarted.current = true;
    track("share_open", { props: { picks: ids.slice(0, TRIO_SIZE) } });
    const ctrl = new AbortController();
    shareCtrl.current = ctrl;
    void Promise.allSettled(ids.map((id) => fetchPlace(id, ctrl.signal))).then((results) => {
      // R61: 멈췄어도(뽑기 등) 다 불러온 것으로 친다 — 미뤄 둔 거점 질문이 영영 안 뜨지 않게
      setShareSettled(true);
      if (ctrl.signal.aborted) return;
      const found = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (found.length === 0) {
        showToast("공유된 가게를 찾지 못했어요");
        return;
      }
      setFullDetails((m) => {
        const next = { ...m };
        for (const p of found) {
          const full = fullOf(p);
          if (full) next[p.id] = full;
        }
        return next;
      });
      // R46: 본 곳 기억은 이번에 받은 곳을 기록하기 전의 것으로 — 이번 결과를 "본 곳"으로 치지 않게
      const seen = seenSnapshot();
      recordSeen(found.map((p) => p.id));
      record("received", found);
      if (ids.length === 1) {
        setReceivedSingle(found[0].id);
        setSelected(found[0]);
      } else {
        setTrio({ ids: found.map((p) => p.id), source: "received", fallback: byId(found), seen });
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
    // R61: 미뤄 둔 첫 접속 질문 전에 거점 칩으로 골랐으면 그게 답이다 (다시 묻지 않는다)
    if (askHub) chooseHub(hubId);
    else update((s) => ({ ...s, hubId }));
    setSelected(null);
    if (hubId !== hub.id) {
      setTrackingHub(hubId);
      track("hub_change");
      // R43: 북마크 거점 경로로 열었으면 주소를 /로 돌린다 (새로고침이 북마크 거점으로 되돌리지 않게)
      const url = urlAfterHubChange(window.location.pathname);
      if (url !== null) window.history.replaceState(null, "", url);
    }
  };
  /** R61: 첫 접속 질문에서 고름 → 저장하고 그 거점 목록을 받는다. app_open을 먼저 남기고 hub_change(onboarding)를 남긴다 */
  const pickHub = (hubId: string) => {
    chooseHub(hubId);
    trackHubPicked(hubId, { radius: filters.radius, party: filters.party }, openTracked.current);
    openTracked.current = true;
  };
  /** R61: 고르지 않고 닫음(✕·끌어내리기·Esc) → 기본 거점으로 고른 것으로 치고 다시 묻지 않는다 (이벤트는 app_open만) */
  const dismissHubPicker = useCallback(() => chooseHub(DEFAULT_HUB_ID), [chooseHub]);
  // R61: 거점 없는 공유 링크면 받은 곳을 다 불러오고 받은 시트를 닫은 뒤에 묻는다
  const pickerOpen = showHubPicker({
    askHub, shareLink: share.placeIds.length > 0, shareSettled, sheetOpen: trio !== null || selected !== null,
  });
  // R61: 질문이 닫히면 포커스를 거점 칩으로 옮기고, 고른 거점을 스크린리더에 조용히 알린다
  const hubButton = useRef<HTMLButtonElement>(null);
  const [hubNotice, setHubNotice] = useState("");
  const pickerWasOpen = useRef(false);
  useEffect(() => {
    if (pickerOpen) {
      pickerWasOpen.current = true;
      return;
    }
    if (!pickerWasOpen.current) return;
    pickerWasOpen.current = false;
    hubButton.current?.focus({ preventScroll: true });
    setHubNotice(`${hub.name}${toParticle(hub.name)} 볼게요`);
  }, [pickerOpen, hub.name]);
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
    if (!auto && !drawGate.current(performance.now())) return;
    // R61: 거점 없는 공유 링크로 열어 아직 거점을 안 골랐으면 받은 시트를 닫아 거점부터 묻는다 (목록은 고른 뒤에 받는다)
    if (askHub && !auto) {
      setTrio(null);
      setFocusId(null);
      setSelected(null);
      return;
    }
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
      // R50: 점심 한가운데엔 가까운 곳, 이른 시간엔 평점 높은 곳을 아주 조금 더
      now: new Date(),
    });
    if (!r) {
      setTrio(null);
      setFocusId(null);
      setSelected(null);
      toast.show("조건에 맞는 곳이 없어요");
      document.getElementById("empty")?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    // R41: 완화로 들어온 곳이 결과에 있으면, 그 곳들이 실제로 어긴 조건만 한 줄로 알린다
    const outsidePicks = r.places.filter((p) => extra.includes(p));
    const outside = new Set(outsidePicks.map((p) => p.id));
    const notice =
      outsidePicks.length > 0 ? relaxNotice(relaxedBy(outsidePicks, filters), relax.addedRadius, candidates.length) : null;
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
        const ids = r.places.map((p) => p.id);
        // R46: 자동 뽑기도 보여준 것이라 본 곳으로 기억한다 (R37 shown 신호와 달리). 판단은 기록하기 전의 기억으로
        const seen = seenSnapshot();
        recordSeen(ids);
        setTrio({ ids, source: "drawn", fallback: byId(r.places), outside, seen });
        if (!auto) record("shown", r.places);
        track(kind, {
          props: {
            candidates: pool, picks: r.places.map((p) => p.id), radius: filters.radius, party: filters.party,
            ...(auto ? { auto: true as const } : {}),
            // R58: R41 완화로 조건 밖 가게가 섞인 뽑기
            ...(outside.size > 0 ? { relaxed: true as const } : {}),
          },
        });
        navigator.vibrate?.(15);
      },
    );
  };

  // R39: 재방문자는 목록이 다 오면 한 번 자동으로 뽑는다 (사용자가 아직 아무것도 누르지 않았을 때만).
  // pending 폴링 중인 일부 목록으로는 보통 뽑지 않고, 폴링이 끝난 뒤(또는 처음부터 다 찬 응답) 한 번만 뽑는다.
  // R45: 24시간 안의 기기 저장본이면(폴링이 끝난 응답을 저장한 것) 그걸로 바로 뽑고, 그보다 오래됐으면 새 목록을 기다린다
  // pending이 끝내 줄지 않는 거점에서 30초를 기다리지 않게, 조건 맞는 후보가 30곳 이상이거나 폴링이 5초를 넘으면 그때 뽑는다
  const autoPool = candidates.length + relax.extra.length;
  const listSettled = hasData && !loading && !polling && fromCache !== "stale";
  const freshPolling = hasData && polling && fromCache !== "stale";
  const pollStart = useRef<number | null>(null);
  const [pollWaited, setPollWaited] = useState(false);
  useEffect(() => {
    if (!freshPolling) {
      pollStart.current = null;
      setPollWaited(false);
      return;
    }
    pollStart.current = Date.now();
    // 폴링 응답이 같은 목록이면 다시 그려지지 않으므로 5초 뒤 한 번 다시 판단하게 한다
    const t = window.setTimeout(() => setPollWaited(true), AUTO_DRAW_POLL_WAIT_MS);
    return () => window.clearTimeout(t);
  }, [freshPolling]);
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
      settled: listSettled,
      pool: autoPool,
      polling: freshPolling,
      strict: candidates.length,
      pollingMs: pollingElapsed(pollWaited, pollStart.current, Date.now()),
    });
    if (!go) return;
    autoDone.current = true;
    markAutoDrawn();
    onDraw({ auto: true });
    // onDraw는 매 렌더 새로 만들어지지만, 목록이 처음 준비됐을 때 한 번만 부르면 된다
  }, [hasData, listSettled, autoPool, returning, share.placeIds, freshPolling, pollWaited, candidates.length]);

  // 셔플 중에는 목록·핀 선택을 받지 않는다 (M2). 결과 3곳 중 하나면 그 카드를 펼친다
  const onSelect = (p: ApiPlace) => {
    if (shuffle.running) return;
    track("select_place", { placeId: p.id });
    if (picks.includes(p.id)) {
      setSelected(null);
      expand(p.id);
      return;
    }
    setSelected(p);
  };

  // R23′: 폰은 시스템 공유 시트, 아니면 클립보드 복사. 공유한 곳은 R37 신호로 남긴다.
  // shareOrCopy는 클릭 핸들러 안에서 await 없이 바로 불러야 한다 (navigator.share는 사용자 동작이 필요)
  const shareOut = async (text: string, ps: ApiPlace[], confirm: boolean) => {
    const outcome = await shareOrCopy(text);
    if (outcome === "shared" || outcome === "copied") {
      record("shared", ps);
      const picks = ps.slice(0, TRIO_SIZE).map((p) => p.id);
      // R58: 확정 공유는 결과 카드 번호도 보낸다 (결과 3곳 밖이면 없음)
      track("share", confirm ? { placeId: ps[0].id, props: { picks, confirm: true, ...rankOf(ps[0].id) } } : { props: { picks } });
    }
    if (outcome === "shared") toast.show("공유했어요", "love");
    else if (outcome === "copied") toast.show("복사했어요", "love");
    else if (outcome === "failed") toast.show("복사하지 못했어요");
  };
  const onShare = (ps: ApiPlace[]) => shareOut(shareText(ps, filters, hub.id, window.location.origin), ps, false);
  /** R47: 펼친 카드의 "여기로 가자고 공유" — 그 한 곳을 확정해서 보낸다 (R37에는 그 한 곳만 shared) */
  const onConfirm = (p: ApiPlace) =>
    shareOut(shareConfirmText(p, hub.id, filters.radius, window.location.origin), [p], true);
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
    expand(id);
  };
  // R37: "다음부터 안 보기" → "{이름}은/는 다음부터 안 뽑아요" + 되돌리기
  const onExclude = (p: ApiPlace) => {
    track("exclude_place", { placeId: p.id, props: rankOf(p.id) });
    personal.exclude(p.id);
    setFocusId(null);
    // 이름을 넣은 알림 + 8초 되돌리기
    toast.show(excludeToastText(p.name), undefined, {
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
  // R63: 마지막 업데이트 날짜와 갱신 요일 (다른 거점 목록이 남아 있는 동안은 숨긴다)
  const note = data && data.center.lat === hub.lat && data.center.lng === hub.lng ? refreshNote(data, hub.refreshDay) : null;
  /** 셔플 중(고르는 중 시트)이거나 결과 3곳 시트가 떠 있음 — 시트 아래 줄이 뽑기 바를 대신한다 (.has-trio) */
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
    // R41: 조건 밖에서 고른 결과가 떠 있으면 "없어요" 대신 그렇게 골랐다고 말한다 (조건 풀기 버튼은 그대로)
    const pickedOutside = trio?.source === "drawn" && (trio.outside?.size ?? 0) > 0;
    list = <EmptyState filters={filters} onChange={setFilters} pickedOutside={pickedOutside} />;
  } else {
    list = (
      <PlaceList
        places={candidates}
        selectedId={selected?.id ?? focusId}
        ranks={ranks}
        sort={filters.sort}
        now={now}
        dim={loading || fromCache === "stale"}
        onSort={(sort) => setFilters({ ...filters, sort })}
        onSelect={onSelect}
      />
    );
  }

  return (
    // R61: 첫 접속 질문이 떠 있으면 토스트(예: 공유된 가게를 못 찾음)를 위쪽에 띄워 거점 줄을 가리지 않게 한다 (.has-sheet)
    <div className={`app${trioOpen || cardPlace || pickerOpen ? " has-sheet" : ""}${trioOpen ? " has-trio" : ""}`}>
      {/* R61: 질문이 떠 있는 동안 뒤 화면은 누를 수도 포커스할 수도 없다 */}
      <header className="topbar" inert={pickerOpen}>
        <h1 className="logo">
          <img src="/brand/logo.webp" alt="모먹죠" width={63} height={28} draggable={false} />
        </h1>
        <HubChip hub={hub} onChange={setHub} buttonRef={hubButton} />
      </header>
      <main className="main" inert={pickerOpen}>
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
              reasons={reasons}
              party={filters.party}
              now={now}
              drawLabel={drawLabel}
              onDraw={() => onDraw()}
              onFocus={onFocus}
              onClose={closeTrio}
              onShare={onShare}
              onConfirm={onConfirm}
              onKakao={onKakao}
              onExclude={onExclude}
            />
          )}
        </section>
        <aside className="panel">
          {/* R61: 첫 방문 안내는 거점을 고른 뒤에 보인다 (질문 위에 겹치지 않게) */}
          {tip.open && !askHub && <FirstTip onClose={tip.dismiss} />}
          <FilterPanel filters={filters} onChange={setFilters} />
          {status && <StatusLine status={status} onRetry={error ? reload : undefined} />}
          {note && <p className="refresh-note">{note}</p>}
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
      {pickerOpen && <HubPicker onPick={pickHub} onDismiss={dismissHubPicker} />}
      <p className="sr-only" role="status" aria-live="polite">
        {hubNotice}
      </p>
      <Toast msg={toast.msg} onAction={toast.hide} onPause={toast.pause} onResume={toast.resume} />
    </div>
  );
}
