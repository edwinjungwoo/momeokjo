import { describe, expect, it } from "vitest";
import { ASEM } from "../../shared/constants";
import { DEFAULT_FILTERS } from "../../shared/recommend";
import { parseShareParams, shareText, shareUrl } from "../../shared/share";
import { apiPlace } from "../helpers/apiPlace";

const ORIGIN = "https://mmj.itmz.me";
const P = apiPlace("27531028", { name: "중앙해장", category: "음식점 > 한식 > 해장국", walkMinutes: 4 }, { rating: 4.1 });

describe("share", () => {
  it("R23: 공유 URL은 p, lat, lng(소수 6자리), r을 담는다", () => {
    expect(shareUrl(ORIGIN, "27531028", ASEM, 700)).toBe(
      "https://mmj.itmz.me/?p=27531028&lat=37.513059&lng=127.059826&r=700",
    );
  });

  it("R23: 공유 텍스트 형식", () => {
    expect(shareText(P, { ...DEFAULT_FILTERS, party: 4 }, ASEM, ORIGIN)).toBe(
      "🍚 4명+ · 60분 → 중앙해장 어때요?\n해장국 · ⭐4.1 · 도보 4분\nhttps://mmj.itmz.me/?p=27531028&lat=37.513059&lng=127.059826&r=700",
    );
  });

  it("R23: 점심시간 선택이 없으면 반경, 평점이 없으면 ⭐ 생략", () => {
    const text = shareText(
      apiPlace("1", { name: "가게", category: "음식점 > 중식", walkMinutes: 9 }, { rating: null }),
      { ...DEFAULT_FILTERS, lunch: null, radius: 850, party: 2 },
      ASEM,
      ORIGIN,
    );
    expect(text.split("\n").slice(0, 2)).toEqual(["🍚 2명 · 반경 850m → 가게 어때요?", "중식 · 도보 9분"]);
  });

  it("R23: 공유 파라미터 파싱 — 유효한 값만 받는다", () => {
    expect(parseShareParams("?p=27531028&lat=37.5&lng=127.05&r=700")).toEqual({
      placeId: "27531028", center: { lat: 37.5, lng: 127.05 }, radius: 700,
    });
    expect(parseShareParams("?p=abc&lat=10&lng=127&r=5000")).toEqual({ placeId: null, center: null, radius: null });
    expect(parseShareParams("")).toEqual({ placeId: null, center: null, radius: null });
  });
});
