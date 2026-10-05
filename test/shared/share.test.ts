import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS } from "../../shared/recommend";
import { parseShareParams, shareText, shareUrl } from "../../shared/share";
import { apiPlace } from "../helpers/apiPlace";

const ORIGIN = "https://mmj.itmz.me";
const P = apiPlace("27531028", { name: "중앙해장", category: "음식점 > 한식 > 해장국", walkMinutes: 4 }, { rating: 4.1 });

describe("share", () => {
  it("R23: 공유 URL은 p, h(거점 id), r을 담는다", () => {
    expect(shareUrl(ORIGIN, "27531028", "bongeunsa", 700)).toBe("https://mmj.itmz.me/?p=27531028&h=bongeunsa&r=700");
  });

  it("R23: 공유 텍스트 형식", () => {
    expect(shareText(P, { ...DEFAULT_FILTERS, party: 4, radius: 700 }, "bongeunsa", ORIGIN)).toBe(
      "🍚 4명+ · 반경 700m → 중앙해장 어때요?\n해장국 · ⭐4.1 · 도보 4분\nhttps://mmj.itmz.me/?p=27531028&h=bongeunsa&r=700",
    );
  });

  it("R23: 평점이 없으면 ⭐ 생략", () => {
    const text = shareText(
      apiPlace("1", { name: "가게", category: "음식점 > 중식", walkMinutes: 9 }, { rating: null }),
      { ...DEFAULT_FILTERS, radius: 850, party: 2 },
      "ddp",
      ORIGIN,
    );
    expect(text.split("\n")).toEqual(["🍚 2명 · 반경 850m → 가게 어때요?", "중식 · 도보 9분", "https://mmj.itmz.me/?p=1&h=ddp&r=850"]);
  });

  it("R23: 공유 파라미터 파싱 — 유효한 값만 받는다 (거점은 목록에 있는 id만, lat/lng는 무시)", () => {
    expect(parseShareParams("?p=27531028&h=ddp&r=700")).toEqual({ placeId: "27531028", hubId: "ddp", radius: 700 });
    expect(parseShareParams("?p=abc&h=gangnam&r=5000")).toEqual({ placeId: null, hubId: null, radius: null });
    expect(parseShareParams("?p=1&lat=37.5&lng=127.05&r=1000")).toEqual({ placeId: "1", hubId: null, radius: 1000 });
    expect(parseShareParams("?r=1050").radius).toBeNull();
    expect(parseShareParams("?r=99").radius).toBeNull();
    expect(parseShareParams("?r=325").radius).toBeNull();
    expect(parseShareParams("?p=1234567890123456").placeId).toBeNull();
    expect(parseShareParams("?p=123456789012345").placeId).toBe("123456789012345");
    expect(parseShareParams("")).toEqual({ placeId: null, hubId: null, radius: null });
  });
});
