import { describe, expect, it } from "vitest";
import { ASEM } from "../../shared/constants";
import { haversine } from "../../shared/geo";
import { LIST_MENUS, listItemJson, placesBody, toApiPlace, withDistance } from "../../worker/present";
import type { PlaceRow } from "../../worker/repo";
import { makeSummary, sampleDetail } from "../helpers/places";

const menus = Array.from({ length: 8 }, (_, i) => ({ name: `메뉴${i}`, price: 10000 + i }));
function row(category: string, tags: string[]): PlaceRow {
  const s = makeSummary(ASEM.lat + 0.001, ASEM.lng);
  return {
    place: { id: "1", name: s.name, categoryName: category, group: "korean", lat: s.lat, lng: s.lng, address: null,
      phone: null, photoUrl: null, url: "https://place.map.kakao.com/1" },
    detail: { ...sampleDetail({ menus, tags, bookable: true }), fetchedAt: 123 },
    meta: { status: "ok", fetchedAt: 123, reason: null },
  };
}

describe("present", () => {
  it("R12: 목록 원소는 태그 대신 soloFriendly/groupFriendly, 메뉴 3개, fetchedAt 없음", () => {
    const p = toApiPlace(row("음식점 > 한식 > 국밥", ["단체석"]), { center: ASEM });
    expect(LIST_MENUS).toBe(3);
    expect(p.detail).toMatchObject({ soloFriendly: true, groupFriendly: true, bookable: true });
    expect(p.detail?.menus).toEqual(menus.slice(0, 3));
    expect(p.detail).not.toHaveProperty("tags");
    expect(p.detail).not.toHaveProperty("fetchedAt");
    expect(p.distance).toBe(111);
  });
  it("R13: 단건(full)은 메뉴를 전부(최대 20개) 준다", () => {
    const p = toApiPlace(row("음식점 > 한식", []), { full: true });
    expect(p.detail?.menus).toEqual(menus);
    expect(p.detail).toMatchObject({ soloFriendly: false, groupFriendly: false });
    expect(p.distance).toBeUndefined();
  });
  it("R48: 단건(full)에만 상세를 가져온 시각 fetchedAt을 싣는다", () => {
    expect(toApiPlace(row("음식점 > 한식", []), { full: true }).fetchedAt).toBe(123);
    expect(toApiPlace(row("음식점 > 한식", []), { center: ASEM })).not.toHaveProperty("fetchedAt");
  });
  it("R45: 좌표는 소수 6자리(약 0.1m)로 줄여 싣는다 — 거리는 줄이기 전 좌표로 계산 (목록 gzip 약 10% 감소)", () => {
    const r = row("음식점 > 한식", []);
    r.place = { ...r.place, lat: 37.51453387676185, lng: 127.06050804655143 };
    const p = toApiPlace(r, { center: ASEM });
    expect([p.lat, p.lng]).toEqual([37.514534, 127.060508]);
    const raw = toApiPlace(r, { center: ASEM, full: true });
    expect([raw.lat, raw.lng]).toEqual([37.514534, 127.060508]);
    expect(p.distance).toBe(Math.round(haversine(ASEM, { lat: 37.51453387676185, lng: 127.06050804655143 })));
  });
  it("R12: 미리 만든 목록 원소 조각(list_json)에 거리를 붙이면 toApiPlace(거리 포함)와 같은 값이다", () => {
    const r = row("음식점 > 한식 > 국밥", ["단체석"]);
    const d = haversine(ASEM, r.place);
    const json = listItemJson(r);
    expect(JSON.parse(json)).not.toHaveProperty("distance");
    expect(JSON.parse(withDistance(json, d))).toEqual(toApiPlace(r, { distance: d }));
  });
  it("R12: 목록 본문은 조각을 이어 붙여 만들고 JSON.parse하면 응답 모양 그대로다", () => {
    const r = row("음식점 > 한식", []);
    const meta = {
      center: ASEM, radius: 1000, pending: 1, incompleteTiles: 0, stale: false, detailsPaused: false,
      detailsFrozenSince: null, detailsNewestAt: 123,
    };
    const body = placesBody(meta, [withDistance(listItemJson(r), 111), withDistance(listItemJson(r), 222)]);
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ ...meta, places: [toApiPlace(r, { distance: 111 }), toApiPlace(r, { distance: 222 })] });
    expect(JSON.parse(placesBody(meta, []))).toEqual({ ...meta, places: [] });
  });
});
