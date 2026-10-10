import { describe, expect, it } from "vitest";
import {
  INTERVAL_WEEKS, MAX_INTERVAL_WEEKS, SHOW_REFRESH_AFTER_MS, WEEK_MS, detailFingerprint, dueAfterOf, fpKind,
} from "../../shared/adaptiveRefresh";
import type { PlaceDetail, PlaceSummary } from "../../shared/types";

const summary = (o: Partial<PlaceSummary> = {}): PlaceSummary => ({
  name: "중앙해장", categoryName: "음식점 > 한식 > 해장국", lat: 37.51, lng: 127.06, address: "서울 강남구 영동대로 1",
  phone: "02-123-4567", photoUrl: "https://t1.kakaocdn.net/a.jpg", ...o,
});
const detail = (o: Partial<PlaceDetail> = {}): PlaceDetail => ({
  rating: 4.23, reviewCount: 120, price: 12000,
  menus: [{ name: "해장국", price: 12000 }, { name: "수육", price: 30000 }],
  hours: { 1: [[660, 1320]], 0: "closed" }, strengths: ["맛", "친절"], bookable: false, tags: ["혼밥"], ...o,
});

describe("R66 표시 정보 지문 (fp)", () => {
  it("R66: 같은 표시 정보면 같은 지문 — 결정적이고 짧은 문자열 (영업시간 키 순서·구간 순서와 상관없다)", () => {
    const a = detailFingerprint(summary(), detail());
    expect(a).toBe(detailFingerprint(summary(), detail()));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    const reordered = detailFingerprint(summary(), detail({ hours: { 0: "closed", 1: [[660, 1320]] } }));
    expect(reordered).toBe(a);
    const twoSlots = (h: [number, number][]) => detailFingerprint(summary(), detail({ hours: { 1: h } }));
    expect(twoSlots([[1020, 1320], [660, 900]])).toBe(twoSlots([[660, 900], [1020, 1320]]));
  });

  it("R66: 리뷰 수·사진·주소·좌표만 바뀌면 같은 지문이다 (바뀐 것으로 치지 않는다), 평점은 0.1 단위로 본다", () => {
    const a = detailFingerprint(summary(), detail());
    expect(detailFingerprint(summary(), detail({ reviewCount: 999 }))).toBe(a);
    expect(detailFingerprint(summary({ photoUrl: null }), detail())).toBe(a);
    expect(detailFingerprint(summary({ photoUrl: "https://t1.kakaocdn.net/b.jpg" }), detail())).toBe(a);
    expect(detailFingerprint(summary({ address: "다른 주소", lat: 37.52, lng: 127.07 }), detail())).toBe(a);
    // 4.23 → 4.2, 4.24 → 4.2 (같음), 4.26 → 4.3 (다름)
    expect(detailFingerprint(summary(), detail({ rating: 4.24 }))).toBe(a);
    expect(detailFingerprint(summary(), detail({ rating: 4.26 }))).not.toBe(a);
  });

  it("R66: 이름·카테고리·평점·가격·영업시간·메뉴(이름·가격·순서)·전화·예약·강점·혼밥/단체 판단이 바뀌면 다른 지문이다", () => {
    const a = detailFingerprint(summary(), detail());
    const changed = [
      detailFingerprint(summary({ name: "중앙해장 본점" }), detail()),
      detailFingerprint(summary({ categoryName: "음식점 > 한식" }), detail()),
      detailFingerprint(summary(), detail({ rating: null })),
      detailFingerprint(summary(), detail({ price: 13000 })),
      detailFingerprint(summary(), detail({ hours: { 1: [[660, 1300]], 0: "closed" } })),
      detailFingerprint(summary(), detail({ hours: null })),
      detailFingerprint(summary(), detail({ menus: [{ name: "해장국", price: 13000 }, { name: "수육", price: 30000 }] })),
      detailFingerprint(summary(), detail({ menus: [{ name: "수육", price: 30000 }, { name: "해장국", price: 12000 }] })),
      detailFingerprint(summary(), detail({ menus: [{ name: "해장국", price: 12000 }] })),
      detailFingerprint(summary({ phone: null }), detail()),
      detailFingerprint(summary(), detail({ bookable: true })),
      detailFingerprint(summary(), detail({ strengths: ["맛"] })),
      detailFingerprint(summary(), detail({ tags: ["단체석"] })),
    ];
    for (const [i, fp] of changed.entries()) expect(fp, String(i)).not.toBe(a);
    // 혼밥 판단에 쓰이지 않는 태그만 바뀌면 화면에 보이는 것이 같다
    expect(detailFingerprint(summary(), detail({ tags: ["혼밥", "주차"] }))).toBe(a);
  });

  it("R66: 이전 지문과 비교 — 없으면 first, 같으면 same, 다르면 changed", () => {
    expect(fpKind(null, "abcd1234")).toBe("first");
    expect(fpKind(undefined, "abcd1234")).toBe("first");
    expect(fpKind("abcd1234", "abcd1234")).toBe("same");
    expect(fpKind("abcd1234", "0000ffff")).toBe("changed");
  });

  it("R66: 주기는 1·2·4주, 다음 갱신 기준 = 가져온 시각 + (주기 − 1) × 7일, 열어 본 가게는 7일이 지나면 다시 가져온다", () => {
    expect(INTERVAL_WEEKS).toEqual([1, 2, 4]);
    expect(MAX_INTERVAL_WEEKS).toBe(4);
    expect(WEEK_MS).toBe(7 * 24 * 3600_000);
    expect(SHOW_REFRESH_AFTER_MS).toBe(7 * 24 * 3600_000);
    expect(dueAfterOf(1000, 1)).toBe(1000);
    expect(dueAfterOf(1000, 2)).toBe(1000 + WEEK_MS);
    expect(dueAfterOf(1000, 4)).toBe(1000 + 3 * WEEK_MS);
  });
});
