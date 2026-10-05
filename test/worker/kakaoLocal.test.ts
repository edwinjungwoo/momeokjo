import { describe, expect, it } from "vitest";
import { parseLocalResponse, searchRect } from "../../worker/kakaoLocal";
import { UpstreamError } from "../../worker/fetchFn";
import dense from "../fixtures/kakao-local/rect-dense-page1.json";
import sparse from "../fixtures/kakao-local/rect-sparse.json";
import { doc, fakeKakaoLocal } from "../helpers/fakeKakao";

const rect = { minLat: 37.51, minLng: 127.05, maxLat: 37.52, maxLng: 127.06 };

describe("kakaoLocal", () => {
  it("R2: 실제 응답을 Place로 변환한다 (하동관)", () => {
    const page = parseLocalResponse(dense)!;
    expect(page.totalCount).toBe(125);
    expect(page.isEnd).toBe(false);
    expect(page.places).toHaveLength(15);
    expect(page.places[0]).toEqual({
      id: "26428654",
      name: "하동관 코엑스몰직영점",
      categoryName: "음식점 > 한식 > 곰탕",
      group: "korean",
      lat: 37.51129046312587,
      lng: 127.05980400928702,
      address: "서울 강남구 영동대로 513",
      phone: "02-551-5959",
      url: "http://place.map.kakao.com/26428654",
    });
  });

  it("R2: 결과가 없으면 빈 목록", () => {
    expect(parseLocalResponse(sparse)).toEqual({ totalCount: 0, isEnd: true, places: [] });
  });

  it("R2: 형식이 다르면 null", () => {
    expect(parseLocalResponse({ meta: {} })).toBeNull();
  });

  it("R2: rect, page, 카테고리, 인증 헤더로 요청한다", async () => {
    let seen: { url: URL; auth: string | null } | null = null;
    await searchRect(
      async (input, init) => {
        seen = { url: new URL(String(input)), auth: new Headers(init?.headers).get("authorization") };
        return Response.json({ meta: { total_count: 0, is_end: true }, documents: [] });
      },
      "k",
      rect,
      2,
    );
    expect(seen!.url.origin + seen!.url.pathname).toBe("https://dapi.kakao.com/v2/local/search/category.json");
    expect(seen!.url.searchParams.get("category_group_code")).toBe("FD6");
    expect(seen!.url.searchParams.get("rect")).toBe("127.05,37.51,127.06,37.52");
    expect(seen!.url.searchParams.get("page")).toBe("2");
    expect(seen!.url.searchParams.get("size")).toBe("15");
    expect(seen!.url.searchParams.get("sort")).toBe("accuracy");
    expect(seen!.auth).toBe("KakaoAK k");
  });

  it("R14: 200이 아니면 UpstreamError(status)", async () => {
    const { fetcher } = fakeKakaoLocal([], { status: 429 });
    await expect(searchRect(fetcher, "k", rect, 1)).rejects.toMatchObject({ name: "UpstreamError", status: 429 });
  });

  it("R14: 네트워크 오류도 UpstreamError(0)", async () => {
    await expect(
      searchRect(async () => { throw new TypeError("down"); }, "k", rect, 1),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("R2: 가짜 서버로 페이지가 나뉜다", async () => {
    const docs = Array.from({ length: 20 }, (_, i) => doc(`d${i}`, 37.515, 127.055));
    const { fetcher } = fakeKakaoLocal(docs);
    const p1 = await searchRect(fetcher, "k", rect, 1);
    const p2 = await searchRect(fetcher, "k", rect, 2);
    expect(p1.places).toHaveLength(15);
    expect(p2.places).toHaveLength(5);
    expect(p2.isEnd).toBe(true);
  });
});
