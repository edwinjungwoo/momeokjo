import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HUBS, READY_HUBS, isPublicHubId, publicHubs, setPublishedHubIds } from "../../shared/hubs";
import { parseSettings } from "../../shared/settings";
import { parseHubPath, parseShareParams } from "../../shared/share";
import { HubPicker } from "../../web/components/HubPicker";
import { pickerHubs } from "../../web/hubLines";
import {
  PUBLIC_HUBS_CACHE_MAX_AGE_MS, PUBLIC_HUBS_KEY, loadPublicHubs, needsHubListFirst, parseHubsResponse, primePublicHubs,
  publicHubsVersion, subscribePublicHubs,
} from "../../web/publicHubs";
import { UNREADY_HUB } from "../helpers/unreadyHub";

// R68: 공개 후보 동작은 테스트 전용 준비 중 거점으로 본다 — HUBS에 더한다
vi.mock("../../shared/hubs", async (orig) => (await import("../helpers/unreadyHub")).withUnreadyHub(orig));

const ID = UNREADY_HUB.id;
const NOW = 1_800_000_000_000;
const memStore = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const body = (ids: string[]) => ({ hubs: HUBS.filter((h) => ids.includes(h.id)).map(({ id, name, lat, lng, refreshDay }) => ({ id, name, lat, lng, refreshDay })) });
const okFetch = (ids: string[]) => vi.fn(async () => new Response(JSON.stringify(body(ids)), { status: 200 }));

afterEach(() => setPublishedHubIds([]));

describe("R68 화면의 런타임 공개 거점", () => {
  it("R68: /api/hubs 응답에서 id만 읽는다 — 모양이 틀리면 null", () => {
    expect(parseHubsResponse(body(["bongeunsa", ID]))).toEqual(["bongeunsa", ID]);
    for (const bad of [null, {}, { hubs: "x" }, { hubs: [{ id: 1 }] }, []]) expect(parseHubsResponse(bad), JSON.stringify(bad)).toBeNull();
  });

  it("R68: 받은 목록으로 공개 후보를 알리고(거점 메뉴·첫 접속 질문·링크·설정 검증이 따라간다) 기기에 기억한다, 구독자에게 알린다", async () => {
    const store = memStore();
    const f = okFetch([...READY_HUBS.map((h) => h.id), ID]);
    const seen = vi.fn();
    const off = subscribePublicHubs(seen);
    const v0 = publicHubsVersion();
    expect(await loadPublicHubs({ fetcher: f, store, now: NOW })).toBe(true);
    off();
    expect(f).toHaveBeenCalledWith("/api/hubs", expect.anything());
    expect(seen).toHaveBeenCalled();
    expect(publicHubsVersion()).not.toBe(v0);
    expect(isPublicHubId(ID)).toBe(true);
    expect(pickerHubs().map((h) => h.id)).toContain(ID);
    expect(renderToStaticMarkup(createElement(HubPicker, { onPick: () => {}, onDismiss: () => {} }))).toContain(UNREADY_HUB.name);
    expect(parseHubPath(`/${ID}`)).toBe(ID);
    expect(parseShareParams(`?h=${ID}`).hubId).toBe(ID);
    expect(parseSettings(JSON.stringify({ hubId: ID })).hubId).toBe(ID);
    expect(JSON.parse(store.m.get(PUBLIC_HUBS_KEY)!)).toEqual({ ids: [ID], at: NOW });
  });

  it("R68: 실패(오프라인·5xx·틀린 본문)하면 알던 목록 그대로 — 처음이면 ready만 (컴파일된 목록)", async () => {
    for (const fetcher of [
      vi.fn(async () => { throw new TypeError("offline"); }),
      vi.fn(async () => new Response("no", { status: 503 })),
      vi.fn(async () => new Response("{}", { status: 200 })),
    ]) {
      expect(await loadPublicHubs({ fetcher, store: memStore(), now: NOW })).toBe(false);
      expect(publicHubs()).toEqual(READY_HUBS);
    }
  });

  it("R68: 기기에 기억한 목록을 시작할 때 바로 쓴다 (7일 넘은 것은 버린다)", () => {
    primePublicHubs(memStore({ [PUBLIC_HUBS_KEY]: JSON.stringify({ ids: [ID], at: NOW - 1000 }) }), NOW);
    expect(isPublicHubId(ID)).toBe(true);
    setPublishedHubIds([]);
    primePublicHubs(memStore({ [PUBLIC_HUBS_KEY]: JSON.stringify({ ids: [ID], at: NOW - PUBLIC_HUBS_CACHE_MAX_AGE_MS - 1 }) }), NOW);
    expect(isPublicHubId(ID)).toBe(false);
    primePublicHubs(memStore({ [PUBLIC_HUBS_KEY]: "{" }), NOW);
    expect(isPublicHubId(ID)).toBe(false);
  });

  it("R68: 처음 열 때 저장값·짧은 링크·공유 링크가 아직 모르는 후보를 가리킬 때만 목록을 기다린다 (그 밖에는 바로 그린다)", () => {
    expect(needsHubListFirst(JSON.stringify({ hubId: ID }), "/", "")).toBe(true);
    expect(needsHubListFirst(null, `/${ID}`, "")).toBe(true);
    expect(needsHubListFirst(null, "/", `?t=1&h=${ID}`)).toBe(true);
    expect(needsHubListFirst(JSON.stringify({ hubId: "ddp" }), "/pangyo", "?h=gangnam")).toBe(false);
    expect(needsHubListFirst("{", "/atlantis", "")).toBe(false);
    setPublishedHubIds([ID]);
    expect(needsHubListFirst(null, `/${ID}`, "")).toBe(false);
  });

  it("R68: 후보가 없으면(지금 운영) /api/hubs를 부르지 않는다", async () => {
    HUBS.splice(HUBS.indexOf(UNREADY_HUB), 1);
    try {
      const f = okFetch([]);
      expect(await loadPublicHubs({ fetcher: f, store: memStore(), now: NOW })).toBe(false);
      expect(f).not.toHaveBeenCalled();
      expect(needsHubListFirst(null, `/${ID}`, "")).toBe(false);
    } finally {
      HUBS.push(UNREADY_HUB);
    }
  });
});
