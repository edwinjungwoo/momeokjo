import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASEM, TILE_TTL_MS } from "../../shared/constants";
import { tileKeyOf, tilesCoveringCircle, walkMinutes } from "../../shared/geo";
import type { PlacesResponse } from "../../shared/types";
import { createApp } from "../../worker/app";
import { getMeta, markTile, replaceTilePlaces } from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { doc, fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { placeJson, seedPlace } from "../helpers/places";

const NOW = 1_800_000_000_000;
const at = (dLat: number) => ASEM.lat + dLat;
const DOCS = [
  doc("1001", at(0.0005), ASEM.lng),
  doc("1002", at(0.001), ASEM.lng, "음식점 > 중식"),
  doc("1003", at(0.0003), ASEM.lng, "음식점 > 간식 > 제과,베이커리"),
  doc("1004", at(0.004), ASEM.lng),
];
const DETAILS = {
  "1001": placeJson({ name: "가게1001", lat: at(0.0005), lng: ASEM.lng }),
  "1002": placeJson({ name: "가게1002", lat: at(0.001), lng: ASEM.lng, category: ["음식점", "중식", "중국요리"] }),
  "1004": placeJson({ name: "가게1004", lat: at(0.004), lng: ASEM.lng }),
};
const Q = `/api/places?lat=${ASEM.lat}&lng=${ASEM.lng}&radius=300`;

function setup(opts: { localStatus?: number; allow?: boolean } = {}) {
  const local = fakeKakaoLocal(DOCS, { status: opts.localStatus });
  const place = fakePlaceApi({ ...DETAILS });
  let limiterCalls = 0;
  const app = createApp({
    fetcher: routeFetch(local.fetcher, place.fetcher),
    now: () => NOW,
    sleep: async () => {},
    rateLimit: async () => {
      limiterCalls += 1;
      return opts.allow ?? true;
    },
  });
  return { app, local, place, limiterCalls: () => limiterCalls };
}

describe("GET /api/places", () => {
  it.each([
    ["lat=10&lng=127&radius=300"],
    ["lat=37.5&lng=127&radius=50"],
    ["lat=37.5&lng=127&radius=3000"],
    ["lat=37.5&lng=127"],
    ["lat=abc&lng=127&radius=300"],
  ])("R12: 잘못된 파라미터는 400 (%s)", async (qs) => {
    const res = await callApp(setup().app, `/api/places?${qs}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_params" });
  });

  it("R12: 처음 요청하면 격자를 수집해 ID만 기록하고, 상세가 아직 없으므로 pending으로 센다", async () => {
    const res = await callApp(setup().app, Q);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as PlacesResponse;
    expect(body).toMatchObject({ center: ASEM, radius: 300, places: [], pending: 2, incompleteTiles: 0, stale: false });
  });

  it("R12: 응답 후 waitUntil로 상세를 보충해서, 다음 요청에는 반경 안 가게가 거리순으로 나오고 공식 API는 다시 부르지 않는다", async () => {
    const { app, local } = setup();
    await callApp(app, Q);
    const localCalls = local.calls.length;
    const body = (await (await callApp(app, Q)).json()) as PlacesResponse;
    expect(local.calls.length).toBe(localCalls);
    expect(body.places.map((p) => p.id)).toEqual(["1001", "1002"]);
    expect(body.places[0].name).toBe("가게1001");
    expect(body.places[0].walkMinutes).toBe(walkMinutes(body.places[0].distance!));
    expect(body.places[1].group).toBe("chinese");
    expect(body.places[0].url).toBe("https://place.map.kakao.com/1001");
    expect(body.places[0].detail?.rating).toBe(4.1);
    expect(body.places[0].detail?.menus.length).toBeLessThanOrEqual(5);
    expect(body.pending).toBe(0);
  });

  it("R14: 공식 API가 실패하고 캐시도 없으면 502", async () => {
    const res = await callApp(setup({ localStatus: 500 }).app, Q);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream" });
  });

  it("R14: 공식 API가 실패해도 만료된 캐시가 있으면 stale로 응답한다", async () => {
    await seedPlace(env.DB, "2001", at(0.0005), ASEM.lng, { now: NOW });
    for (const k of tilesCoveringCircle(ASEM, 300)) await markTile(env.DB, k, NOW - TILE_TTL_MS, 0, false);
    await replaceTilePlaces(env.DB, tileKeyOf(ASEM), ["2001"], NOW - TILE_TTL_MS, false);
    const body = (await (await callApp(setup({ localStatus: 500 }).app, Q)).json()) as PlacesResponse;
    expect(body.stale).toBe(true);
    expect(body.places.map((p) => p.id)).toEqual(["2001"]);
  });

  it("R15: 요청 제한에 걸리면 외부 호출 없이 캐시로만 응답하고 stale", async () => {
    const { app, local, place } = setup({ allow: false });
    const body = (await (await callApp(app, Q)).json()) as PlacesResponse;
    expect(local.calls).toHaveLength(0);
    expect(place.calls).toHaveLength(0);
    expect(body).toMatchObject({ stale: true, places: [], incompleteTiles: tilesCoveringCircle(ASEM, 300).length });
  });

  it("R15: 격자와 상세가 모두 신선하면 요청 제한을 확인하지 않는다", async () => {
    const s = setup();
    await callApp(s.app, Q);
    await callApp(s.app, Q);
    const before = s.limiterCalls();
    await callApp(s.app, Q);
    expect(s.limiterCalls()).toBe(before);
  });
});

describe("GET /api/places/:id", () => {
  it("R13: 숫자가 아닌 id는 외부 호출 없이 404", async () => {
    const { app, place } = setup();
    expect((await callApp(app, "/api/places/abc")).status).toBe(404);
    expect(place.calls).toHaveLength(0);
  });

  it("R13: 표시 정보가 없으면 상세를 한 번 가져와서 준다 (distance 없음)", async () => {
    const res = await callApp(setup().app, "/api/places/1001");
    expect(res.status).toBe(200);
    const p = await res.json<any>();
    expect(p).toMatchObject({ id: "1001", name: "가게1001", detail: { rating: 4.1 } });
    expect(p.distance).toBeUndefined();
  });

  it("R13: 상세를 가져오지 못하면 404이고 실패를 기록한다", async () => {
    const res = await callApp(setup().app, "/api/places/999");
    expect(res.status).toBe(404);
    expect((await getMeta(env.DB, "999"))?.reason).toBe("http_404");
  });

  it("R13: 최근에 실패한 장소는 다시 시도하지 않는다", async () => {
    const { app, place } = setup();
    await callApp(app, "/api/places/999");
    await callApp(app, "/api/places/999");
    expect(place.calls.filter((c) => c.id === "999")).toHaveLength(1);
  });
});
