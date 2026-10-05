import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DETAIL_JITTER_MS, DETAIL_OK_TTL_MS, PLACE_BLOCK_COOLDOWN_MS, TILE_TTL_MS,
} from "../../shared/constants";
import { hubById } from "../../shared/hubs";
import { tileKeyOf, tilesCoveringCircle, walkMinutes } from "../../shared/geo";
import type { PlacesResponse } from "../../shared/types";
import {
  PLACES_CACHE_MS, PLACES_PENDING_CACHE_MS, PLACE_TRANSIENT_CACHE_MS, createApp, placeCacheKey, placesCacheKey, placesCacheTtl,
} from "../../worker/app";
import { detailGate, getMeta, markTile, recordPlaceBlock, replaceTilePlaces, resetCorruptWarnings } from "../../worker/repo";
import { callApp } from "../helpers/callApp";
import { doc, fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { markOuterTilesFresh, placeJson, seedPlace } from "../helpers/places";

const NOW = 1_800_000_000_000;
const HUB = hubById("bongeunsa");
const HUB_CENTER = { lat: HUB.lat, lng: HUB.lng };
const at = (dLat: number) => HUB.lat + dLat;
const DOCS = [
  doc("1001", at(0.0005), HUB.lng),
  doc("1002", at(0.001), HUB.lng, "음식점 > 중식"),
  doc("1003", at(0.0003), HUB.lng, "음식점 > 간식 > 제과,베이커리"),
  doc("1004", at(0.004), HUB.lng),
];
const DETAILS = {
  "1001": placeJson({ name: "가게1001", lat: at(0.0005), lng: HUB.lng }),
  "1002": placeJson({ name: "가게1002", lat: at(0.001), lng: HUB.lng, category: ["음식점", "중식", "중국요리"] }),
  "1004": placeJson({ name: "가게1004", lat: at(0.004), lng: HUB.lng }),
  // 어느 격자에도 기록되지 않은 가게 (공유 링크로만 들어온다)
  "5555": placeJson({ name: "가게5555", lat: at(0.0002), lng: HUB.lng }),
};
const Q = "/api/places?hub=bongeunsa&radius=300";

// 서버는 반경과 상관없이 1000m를 계산한다 — 300m 밖 격자는 방금 수집한 빈 격자로 둔다
beforeEach(() => markOuterTilesFresh(env.DB, HUB_CENTER, 300, NOW));

function setup(opts: { localStatus?: number; allow?: boolean; details?: Record<string, unknown> } = {}) {
  const local = fakeKakaoLocal(DOCS, { status: opts.localStatus });
  const place = fakePlaceApi({ ...DETAILS, ...opts.details });
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
    ["hub=gangnam&radius=300"],
    ["hub=bongeunsa&radius=50"],
    ["hub=bongeunsa&radius=1050"],
    ["hub=bongeunsa&radius=325"],
    ["hub=bongeunsa&radius=abc"],
    ["hub=bongeunsa"],
    ["radius=300"],
    ["lat=37.514255&lng=127.060234&radius=300"],
  ])("R12: 잘못된 파라미터는 400 (%s)", async (qs) => {
    const res = await callApp(setup().app, `/api/places?${qs}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_params" });
  });

  it("R12: 거점 id와 50m 단위 반경(100~1000m)만 받는다", async () => {
    for (const r of [100, 650, 1000]) {
      const res = await callApp(setup({ allow: false }).app, `/api/places?hub=ddp&radius=${r}`);
      expect(res.status).toBe(200);
    }
  });

  it("R12: 처음 요청하면 격자를 수집해 ID만 기록하고, 상세가 아직 없으므로 pending으로 센다", async () => {
    const res = await callApp(setup().app, Q);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as PlacesResponse;
    // R42: radius=300을 보내도 서버는 1000m를 계산한다 — pending은 1001, 1002, 1004 (디저트 1003은 기록 안 함)
    expect(body).toMatchObject({ center: HUB_CENTER, radius: 1000, places: [], pending: 3, incompleteTiles: 0, stale: false });
  });

  it("R12: 응답 후 waitUntil로 상세를 보충해서, 다음 요청에는 반경 안 가게가 거리순으로 나오고 공식 API는 다시 부르지 않는다", async () => {
    const { app, local } = setup();
    await callApp(app, Q);
    const localCalls = local.calls.length;
    const body = (await (await callApp(app, Q)).json()) as PlacesResponse;
    expect(local.calls.length).toBe(localCalls);
    expect(body.places.map((p) => p.id)).toEqual(["1001", "1002", "1004"]);
    expect(body.places[0].name).toBe("가게1001");
    expect(body.places[0].walkMinutes).toBe(walkMinutes(body.places[0].distance!));
    expect(body.places[1].group).toBe("chinese");
    expect(body.places[0].url).toBe("https://place.map.kakao.com/1001");
    expect(body.places[0].detail?.rating).toBe(4.1);
    expect(body.places[0].detail?.menus).toHaveLength(3);
    expect(body.places[0].detail).not.toHaveProperty("tags");
    expect(body.pending).toBe(0);
    expect(body.places[0].photoUrl).toBe("https://t1.kakaocdn.net/fiy_reboot/place/B6D1BA174D394DEDB42B4411705FFDE7");
  });

  it("R14: 공식 API가 실패하고 캐시도 없으면 502", async () => {
    const res = await callApp(setup({ localStatus: 500 }).app, Q);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream" });
  });

  it("R14: 공식 API가 실패해도 만료된 캐시가 있으면 stale로 응답한다", async () => {
    await seedPlace(env.DB, "2001", at(0.0005), HUB.lng, { now: NOW });
    for (const k of tilesCoveringCircle(HUB, 300)) await markTile(env.DB, k, NOW - TILE_TTL_MS, 0, false);
    await replaceTilePlaces(env.DB, tileKeyOf(HUB), ["2001"], NOW - TILE_TTL_MS, false);
    const body = (await (await callApp(setup({ localStatus: 500 }).app, Q)).json()) as PlacesResponse;
    expect(body.stale).toBe(true);
    expect(body.places.map((p) => p.id)).toEqual(["2001"]);
  });

  it("R15: 요청 제한에 걸리면 외부 호출 없이 캐시로만 응답한다 — 못 모은 격자는 incompleteTiles로 알리고 stale은 아니다(10초 캐시)", async () => {
    const { app, local, place } = setup({ allow: false });
    const body = (await (await callApp(app, Q)).json()) as PlacesResponse;
    expect(local.calls).toHaveLength(0);
    expect(place.calls).toHaveLength(0);
    expect(body).toMatchObject({ stale: false, places: [], incompleteTiles: tilesCoveringCircle(HUB, 300).length });
    expect(placesCacheTtl(body)).toBe(PLACES_PENDING_CACHE_MS);
  });

  it("R15: 상세 보충만 요청 제한에 걸리면 보충을 건너뛸 뿐 stale이 아니고 pending은 그대로 (10초 캐시)", async () => {
    const s = setup();
    await callApp(s.app, Q); // 격자 수집 (보충은 waitUntil)
    await env.DB.prepare("DELETE FROM places WHERE id = '1002'").run();
    const limited = setup({ allow: false });
    const body = (await (await callApp(limited.app, Q)).json()) as PlacesResponse;
    expect(limited.place.calls).toHaveLength(0);
    expect(body).toMatchObject({ stale: false, pending: 1, incompleteTiles: 0, detailsPaused: false });
    expect(placesCacheTtl(body)).toBe(PLACES_PENDING_CACHE_MS);
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

describe("GET /api/places — 응답 캐시와 목록 원소", () => {
  it("R12: 캐시 시간 — 다 찬 응답·frozen·쿨다운(detailsPaused)이면 60초, pending이나 수집 중 격자가 남으면 10초, 외부 실패(stale)만 두지 않는다", () => {
    const base: PlacesResponse = {
      center: HUB_CENTER, radius: 1000, places: [], pending: 0, incompleteTiles: 0, stale: false, detailsPaused: false,
      detailsFrozenSince: null, detailsNewestAt: null,
    };
    expect(PLACES_CACHE_MS).toBe(60_000);
    expect(PLACES_PENDING_CACHE_MS).toBe(10_000);
    expect(placesCacheTtl(base)).toBe(PLACES_CACHE_MS);
    expect(placesCacheTtl({ ...base, pending: 3 })).toBe(PLACES_PENDING_CACHE_MS);
    // R44 frozen: pending이 줄 수 없다
    expect(placesCacheTtl({ ...base, pending: 3, detailsPaused: true, detailsFrozenSince: NOW })).toBe(PLACES_CACHE_MS);
    // R10 쿨다운: 30분 동안 아무도 pending을 줄일 수 없다
    expect(placesCacheTtl({ ...base, pending: 3, detailsPaused: true })).toBe(PLACES_CACHE_MS);
    // 격자를 아직 다 모으지 못했으면(요청 제한·예산) 짧게만
    expect(placesCacheTtl({ ...base, incompleteTiles: 1 })).toBe(PLACES_PENDING_CACHE_MS);
    expect(placesCacheTtl({ ...base, pending: 3, incompleteTiles: 1 })).toBe(PLACES_PENDING_CACHE_MS);
    expect(placesCacheTtl({ ...base, pending: 3, incompleteTiles: 1, detailsPaused: true })).toBe(PLACES_PENDING_CACHE_MS);
    // 공식 API 실패가 섞인 응답만 두지 않는다
    expect(placesCacheTtl({ ...base, stale: true })).toBeNull();
    expect(placesCacheTtl({ ...base, pending: 3, stale: true })).toBeNull();
  });

  it("R10/R12: 쿨다운 중이면 detailsPaused=true이고 pending이 남아도 60초 캐시한다", async () => {
    await recordPlaceBlock(env.DB, NOW);
    const cache = caches.default;
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
    const s = setup();
    const app = createApp({
      fetcher: routeFetch(s.local.fetcher, s.place.fetcher), now: () => NOW, sleep: async () => {}, rateLimit: async () => true, cache,
    });
    const body = (await (await callApp(app, Q)).json()) as PlacesResponse;
    expect(body).toMatchObject({ pending: 3, detailsPaused: true, stale: false });
    const stored = await cache.match(new Request(placesCacheKey("bongeunsa")));
    expect(stored?.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
  });

  it("R12: 평소에는 detailsPaused=false", async () => {
    const s = setup();
    await callApp(s.app, Q);
    const body = (await (await callApp(s.app, Q)).json()) as PlacesResponse;
    expect(body.detailsPaused).toBe(false);
  });

  it("R12: 다 채워진 응답은 Workers Cache API에 60초 캐시해서, 캐시 적중이면 D1을 읽지 않고 같은 본문을 준다", async () => {
    const cache = caches.default;
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
    let now = NOW;
    const local = fakeKakaoLocal(DOCS);
    const place = fakePlaceApi({ ...DETAILS });
    const app = createApp({
      fetcher: routeFetch(local.fetcher, place.fetcher), now: () => now, sleep: async () => {}, rateLimit: async () => true, cache,
    });
    const first = await callApp(app, Q); // pending이 남음 → 10초만 캐시 (R12 폴링 공유)
    const firstBody = await first.text();
    expect((JSON.parse(firstBody) as PlacesResponse).pending).toBeGreaterThan(0);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const short = await cache.match(new Request(placesCacheKey("bongeunsa")));
    expect(short?.headers.get("cache-control")).toBe("public, max-age=10, s-maxage=10");
    // 10초 안의 폴링은 같은 pending 응답을 나눠 쓴다 (보충을 다시 시작하지 않는다)
    const callsAfterFirst = local.calls.length + place.calls.length;
    now += 5_000;
    expect(await (await callApp(app, Q)).text()).toBe(firstBody);
    expect(local.calls.length + place.calls.length).toBe(callsAfterFirst);
    now += 5_000;
    const second = await callApp(app, Q);
    const secondBody = await second.text();
    expect(second.headers.get("cache-control")).toBe("no-store");
    const stored = await cache.match(new Request(placesCacheKey("bongeunsa")));
    expect(stored?.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    // D1을 비워도 캐시 적중이면 같은 본문 (D1을 읽지 않는다)
    await env.DB.prepare("DELETE FROM places").run();
    await env.DB.prepare("DELETE FROM tile_places").run();
    await env.DB.prepare("DELETE FROM tiles").run();
    const callsBefore = local.calls.length + place.calls.length;
    const hit = await callApp(app, Q);
    expect(await hit.text()).toBe(secondBody);
    expect(hit.headers.get("cache-control")).toBe("no-store");
    expect(local.calls.length + place.calls.length).toBe(callsBefore);
    // 60초가 지나면 다시 만든다
    now += 60_000;
    const fresh = (await (await callApp(app, Q)).json()) as PlacesResponse;
    expect(fresh.places).toEqual([]);
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
  });

  it("R12/R42: 반경이 달라도 거점마다 캐시 키 하나 — radius=500과 1000은 같은 1000m 본문을 같은 캐시에서 받는다 (두 번째는 D1을 읽지 않는다)", async () => {
    const cache = caches.default;
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
    const s = setup();
    const app = createApp({
      fetcher: routeFetch(s.local.fetcher, s.place.fetcher), now: () => NOW, sleep: async () => {}, rateLimit: async () => true, cache,
    });
    await callApp(s.app, Q); // 격자·상세를 채운다 (캐시 없는 앱)
    const first = await callApp(app, "/api/places?hub=bongeunsa&radius=1000");
    const firstBody = await first.text();
    const parsed = JSON.parse(firstBody) as PlacesResponse;
    expect(parsed).toMatchObject({ radius: 1000, pending: 0, incompleteTiles: 0 });
    expect(parsed.places.map((p) => p.id)).toEqual(["1001", "1002", "1004"]);
    const usage = async () =>
      Number((await env.DB.prepare("SELECT value FROM meta WHERE key LIKE 'd1_read:%'").first<{ value: string }>())?.value ?? 0);
    const readBefore = await usage();
    const second = await callApp(app, "/api/places?hub=bongeunsa&radius=500");
    expect(await second.text()).toBe(firstBody);
    expect(await usage()).toBe(readBefore);
    await cache.delete(new Request(placesCacheKey("bongeunsa")));
  });

  it("R12: 미리 만든 목록 조각(list_json)으로 만든 본문과, 조각이 없는 예전 행(열에서 만듦)의 본문은 글자까지 같다", async () => {
    const s = setup();
    await callApp(s.app, Q);
    const fast = await (await callApp(s.app, Q)).text();
    expect((JSON.parse(fast) as PlacesResponse).places).toHaveLength(3);
    const filled = await env.DB.prepare("SELECT count(*) AS c FROM places WHERE list_json IS NOT NULL").first<{ c: number }>();
    expect(filled?.c).toBe(3);
    await env.DB.prepare("UPDATE places SET list_json = NULL").run();
    expect(await (await callApp(s.app, Q)).text()).toBe(fast);
  });

  it("R12/D-8: 예전 판(LIST_JSON_VERSION이 다름)이거나 비었거나 깨진 조각은 쓰지 않고 열에서 만든다 — 본문은 글자까지 같다", async () => {
    const s = setup();
    await callApp(s.app, Q);
    const fast = await (await callApp(s.app, Q)).text();
    const bogus = '{"id":"bogus","name":"옛 모양"}';
    for (const stale of [bogus, `v0:${bogus}`, `v2:${bogus}`, "", "v1:", "v1:garbage", `v1:[${bogus}]`]) {
      await env.DB.prepare("UPDATE places SET list_json = ?").bind(stale).run();
      expect(await (await callApp(s.app, Q)).text(), JSON.stringify(stale)).toBe(fast);
    }
  });

  it("R12: 응답·목록 원소·detail에는 정해진 키만 싣는다 (목록 크기 회귀 방지)", async () => {
    const s = setup();
    await callApp(s.app, Q);
    const body = (await (await callApp(s.app, Q)).json()) as PlacesResponse;
    expect(Object.keys(body).sort()).toEqual(
      ["center", "detailsFrozenSince", "detailsNewestAt", "detailsPaused", "incompleteTiles", "pending", "places", "radius", "stale"],
    );
    expect(body.places.length).toBeGreaterThan(0);
    for (const p of body.places) {
      expect(Object.keys(p).sort()).toEqual(
        ["category", "detail", "distance", "group", "id", "lat", "lng", "name", "photoUrl", "url", "walkMinutes"],
      );
      expect(Object.keys(p.detail!).sort()).toEqual(
        ["bookable", "groupFriendly", "hours", "menus", "price", "rating", "reviewCount", "soloFriendly", "strengths"],
      );
    }
  });

  it("R12: 목록 원소에는 화면이 쓰지 않는 주소·전화번호를 싣지 않는다 (단건에는 있다)", async () => {
    const s = setup();
    await callApp(s.app, Q);
    const body = (await (await callApp(s.app, Q)).json()) as PlacesResponse;
    expect(body.places[0]).not.toHaveProperty("address");
    expect(body.places[0]).not.toHaveProperty("phone");
    const one = await (await callApp(s.app, "/api/places/1001")).json<any>();
    expect(one).toHaveProperty("address");
  });

  it("R48: 단건에만 상세를 가져온 시각 fetchedAt(epoch ms)을 싣는다 (목록 원소에는 없다)", async () => {
    const s = setup();
    await callApp(s.app, Q);
    const body = (await (await callApp(s.app, Q)).json()) as PlacesResponse;
    expect(body.places.length).toBeGreaterThan(0);
    for (const p of body.places) expect(p).not.toHaveProperty("fetchedAt");
    const one = await (await callApp(s.app, "/api/places/1001")).json<any>();
    expect(one.fetchedAt).toBe(NOW);
    expect(one.detail).not.toHaveProperty("fetchedAt");
  });
});

describe("GET /api/places — 저장값 방어 (QA 보강)", () => {
  it("R12/D-8: 저장된 JSON 열(메뉴·영업시간·강점·태그)이 깨졌거나 모양이 틀린 행이 있어도 목록은 200이고 그 필드만 빈 값", async () => {
    const s = setup();
    await callApp(s.app, Q);
    await callApp(s.app, Q);
    // 열에서 목록을 만드는 길(list_json이 없는 예전 행)을 시험한다
    await env.DB.prepare("UPDATE places SET list_json = NULL").run();
    await env.DB.prepare("UPDATE places SET menus_json = '{', hours_json = 'x', strengths_json = '[', tags_json = 'null}' WHERE id = '1001'").run();
    await env.DB.prepare(`UPDATE places SET menus_json = '{}', hours_json = '[1]', strengths_json = '"맛"', tags_json = '7' WHERE id = '1002'`).run();
    const res = await callApp(s.app, Q);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlacesResponse;
    expect(body.places.map((p) => p.id)).toEqual(["1001", "1002", "1004"]);
    for (const p of body.places.filter((x) => x.id !== "1004")) {
      expect(p.detail).toMatchObject({ menus: [], hours: null, strengths: [], rating: 4.1 });
    }
    const one = await callApp(s.app, "/api/places/1001");
    expect(one.status).toBe(200);
    const detail = (await one.json<any>()).detail;
    expect(detail).toMatchObject({ menus: [], hours: null, strengths: [], rating: 4.1, groupFriendly: false });
    // 태그는 응답에 싣지 않는다 (깨진 태그는 빈 배열로 읽혀 단체 판단이 거짓)
    expect(detail).not.toHaveProperty("tags");
  });

  it("R12/D-8: 깨진 JSON 열은 행 id와 열 이름으로 console.warn에 남기고, 멀쩡한 행은 남기지 않는다", async () => {
    const s = setup();
    await callApp(s.app, Q);
    await callApp(s.app, Q);
    await env.DB.prepare("UPDATE places SET list_json = NULL").run();
    await env.DB.prepare("UPDATE places SET menus_json = '{', tags_json = '7' WHERE id = '1001'").run();
    // 앞 테스트가 같은 행을 이미 경고했다 (isolate마다 한 번만 남긴다)
    resetCorruptWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await callApp(s.app, Q)).status).toBe(200);
      const calls = warn.mock.calls.filter((c) => c[0] === "corrupt json column");
      expect(calls.map((c) => c[1])).toEqual([
        { id: "1001", col: "menus_json" },
        { id: "1001", col: "tags_json" },
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GET /api/places — 요청 시점 보충", () => {
  it("R12: 만료된 상세는 요청에서 갱신하지 않고(Cron 몫) 그대로 보여준다", async () => {
    const s = setup();
    await callApp(s.app, Q);
    await callApp(s.app, Q);
    const old = NOW - DETAIL_OK_TTL_MS - DETAIL_JITTER_MS;
    await env.DB.prepare("UPDATE places SET fetched_at = ?").bind(old).run();
    const before = s.place.calls.length;
    const body = (await (await callApp(s.app, Q)).json()) as PlacesResponse;
    expect(s.place.calls.length).toBe(before);
    expect(body.places.map((p) => p.id)).toEqual(["1001", "1002", "1004"]);
    expect(body.pending).toBe(0);
  });

  it("R10/R12: 쿨다운 중이면 보충을 시작하지 않는다", async () => {
    await recordPlaceBlock(env.DB, NOW);
    const s = setup();
    await callApp(s.app, Q);
    expect(s.place.calls).toHaveLength(0);
  });
});

describe("GET /api/places/:id", () => {
  it("R10/R13: 쿨다운 중이면 외부 호출 없이 404이고 실패로 기록하지 않는다", async () => {
    await recordPlaceBlock(env.DB, NOW);
    const { app, place } = setup();
    expect((await callApp(app, "/api/places/1001")).status).toBe(404);
    expect(place.calls).toHaveLength(0);
    expect(await getMeta(env.DB, "1001")).toBeNull();
  });

  it("R10/R13: 단건 조회에서 429가 나오면 쿨다운을 기록한다", async () => {
    const { app } = setup({ details: { "777": 429 } });
    await replaceTilePlaces(env.DB, tileKeyOf(HUB), ["777"], NOW, false);
    expect((await callApp(app, "/api/places/777")).status).toBe(404);
    expect((await detailGate(env.DB)).blockedUntil).toBe(NOW + PLACE_BLOCK_COOLDOWN_MS);
  });

  it("R13: 숫자가 아닌 id는 외부 호출 없이 404", async () => {
    const { app, place } = setup();
    expect((await callApp(app, "/api/places/abc")).status).toBe(404);
    expect(place.calls).toHaveLength(0);
  });

  it("R13: 16자리 이상 id는 외부 호출 없이 404", async () => {
    const { app, place } = setup();
    expect((await callApp(app, "/api/places/1234567890123456")).status).toBe(404);
    expect(place.calls).toHaveLength(0);
  });

  it("R13: id 경계 — 음수·소수·공백(SQL 같은 글자)·인코딩된 경로·전각 숫자는 외부 호출과 D1 쓰기 없이 404", async () => {
    const { app, place } = setup();
    for (const id of ["-1", "1.5", "1%20OR%201=1", "..%2Fadmin%2Faudit", "%EF%BC%91%EF%BC%92"]) {
      expect((await callApp(app, `/api/places/${id}`)).status, id).toBe(404);
    }
    expect(place.calls).toHaveLength(0);
    expect((await env.DB.prepare("SELECT count(*) AS c FROM places").first<{ c: number }>())?.c).toBe(0);
  });

  it("R12/R13: 격자에 없는 가게는 단건 조회로 저장돼도 /api/places 목록에 나오지 않는다", async () => {
    const { app } = setup();
    expect((await callApp(app, "/api/places/5555")).status).toBe(200);
    await callApp(app, Q);
    const body = (await (await callApp(app, Q)).json()) as PlacesResponse;
    expect(body.places.map((p) => p.id)).toEqual(["1001", "1002", "1004"]);
    expect((await callApp(app, "/api/places/5555")).status).toBe(200);
  });

  it("R13: 표시 정보가 없으면 상세를 한 번 가져와서 준다 (distance 없음)", async () => {
    const res = await callApp(setup().app, "/api/places/1001");
    expect(res.status).toBe(200);
    const p = await res.json<any>();
    expect(p).toMatchObject({ id: "1001", name: "가게1001", detail: { rating: 4.1 } });
    expect(p.detail.menus).toHaveLength(6);
    expect(p.distance).toBeUndefined();
  });

  it("R13: 격자에 있는 장소의 상세를 가져오지 못하면 404이고 실패를 기록한다", async () => {
    await replaceTilePlaces(env.DB, tileKeyOf(HUB), ["999"], NOW, false);
    const res = await callApp(setup().app, "/api/places/999");
    expect(res.status).toBe(404);
    expect((await getMeta(env.DB, "999"))?.reason).toBe("http_404");
  });

  it("R13: 격자에 없는 id는 실패해도 D1에 아무것도 쓰지 않는다 (아무 id로 D1을 키울 수 없게)", async () => {
    const res = await callApp(setup().app, "/api/places/998");
    expect(res.status).toBe(404);
    expect(await getMeta(env.DB, "998")).toBeNull();
    const r = await env.DB.prepare("SELECT count(*) AS c FROM places").first<{ c: number }>();
    expect(r?.c).toBe(0);
  });

  it("R13/R38: 거점 격자에 없는 id는 상세를 받아 보여주되 D1에 저장하지 않는다 (예전 고리 격자에만 있는 id 포함)", async () => {
    const far = tileKeyOf({ lat: HUB.lat + 0.03, lng: HUB.lng }); // 약 3.3km 북쪽 — 어느 거점의 1000m 격자도 아니다
    await replaceTilePlaces(env.DB, far, ["1004"], NOW, false);
    const s = setup();
    for (const id of ["5555", "1004"]) {
      const res = await callApp(s.app, `/api/places/${id}`);
      expect(res.status, id).toBe(200);
      expect((await res.json<any>()).name).toBe(`가게${id}`);
      expect(await getMeta(env.DB, id), id).toBeNull();
    }
    // 거점 격자에 있는 id는 저장한다
    await replaceTilePlaces(env.DB, tileKeyOf(HUB), ["1001"], NOW, false);
    expect((await callApp(s.app, "/api/places/1001")).status).toBe(200);
    expect((await getMeta(env.DB, "1001"))?.status).toBe("ok");
  });

  it("R13/R38: 거점 격자 밖 id의 단건 응답은 id별로 60초 엣지 캐시해서, 다시 열어도 상세 API를 다시 부르지 않는다", async () => {
    expect(PLACE_TRANSIENT_CACHE_MS).toBe(60_000);
    const cache = caches.default;
    for (const id of ["5555", "1001"]) await cache.delete(new Request(placeCacheKey(id)));
    let now = NOW;
    const s = setup();
    const app = createApp({
      fetcher: routeFetch(s.local.fetcher, s.place.fetcher), now: () => now, sleep: async () => {}, rateLimit: async () => true, cache,
    });
    const calls = () => s.place.calls.filter((c) => c.id === "5555").length;
    const first = await callApp(app, "/api/places/5555");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const body = await first.text();
    const stored = await cache.match(new Request(placeCacheKey("5555")));
    expect(stored?.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    now += PLACE_TRANSIENT_CACHE_MS - 1;
    const again = await callApp(app, "/api/places/5555");
    expect(again.status).toBe(200);
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(await again.text()).toBe(body);
    expect(calls()).toBe(1);
    expect(await getMeta(env.DB, "5555")).toBeNull(); // 여전히 저장하지 않는다
    // 60초가 지나면 다시 가져온다
    now += 1;
    expect((await callApp(app, "/api/places/5555")).status).toBe(200);
    expect(calls()).toBe(2);
    // 거점 격자 안의 id는 D1에 저장하므로 엣지에 따로 두지 않는다
    await replaceTilePlaces(env.DB, tileKeyOf(HUB), ["1001"], NOW, false);
    expect((await callApp(app, "/api/places/1001")).status).toBe(200);
    expect(await cache.match(new Request(placeCacheKey("1001")))).toBeUndefined();
    for (const id of ["5555", "1001"]) await cache.delete(new Request(placeCacheKey(id)));
  });

  it("R13: 거점 격자 밖 id의 실패는 기록하지 않는다", async () => {
    const far = tileKeyOf({ lat: HUB.lat + 0.03, lng: HUB.lng });
    await replaceTilePlaces(env.DB, far, ["999"], NOW, false);
    expect((await callApp(setup().app, "/api/places/999")).status).toBe(404);
    expect(await getMeta(env.DB, "999")).toBeNull();
  });

  it("R13: 최근에 실패한 장소는 다시 시도하지 않는다", async () => {
    await replaceTilePlaces(env.DB, tileKeyOf(HUB), ["999"], NOW, false);
    const { app, place } = setup();
    await callApp(app, "/api/places/999");
    await callApp(app, "/api/places/999");
    expect(place.calls.filter((c) => c.id === "999")).toHaveLength(1);
  });
});
