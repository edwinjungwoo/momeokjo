import { describe, expect, it } from "vitest";
import { Budget } from "../../worker/budget";
import { fetchPlaceDetail } from "../../worker/kakaoPlace";
import jungang from "../fixtures/place-detail/27531028-jungang-haejang.json";
import { fakePlaceApi } from "../helpers/fakeKakao";

const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };

describe("fetchPlaceDetail", () => {
  it("R6: 정상 응답이면 파싱된 상세를 돌려주고 필수 헤더를 보낸다", async () => {
    const api = fakePlaceApi({ "27531028": jungang });
    const r = await fetchPlaceDetail(api.fetcher, "27531028", { budget: new Budget(5), sleep });
    expect(r.ok && r.detail.rating).toBe(4.1);
    const h = api.calls[0].headers;
    expect(h.get("pf")).toBe("PC");
    expect(h.get("referer")).toBe("https://place.map.kakao.com/");
    expect(h.get("origin")).toBe("https://place.map.kakao.com");
  });

  it("R9: 5xx면 250ms, 1000ms 백오프로 최대 2번 재시도한다", async () => {
    sleeps.length = 0;
    const api = fakePlaceApi({ a: [500, 503, jungang] });
    const r = await fetchPlaceDetail(api.fetcher, "a", { budget: new Budget(5), sleep });
    expect(r.ok).toBe(true);
    expect(api.calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 1000]);
  });

  it("R9: 재시도를 다 써도 실패하면 http_상태", async () => {
    sleeps.length = 0;
    const api = fakePlaceApi({ a: [500, 500, 500] });
    expect(await fetchPlaceDetail(api.fetcher, "a", { budget: new Budget(5), sleep })).toEqual({ ok: false, reason: "http_500" });
    expect(api.calls).toHaveLength(3);
  });

  it("R9: 네트워크 오류도 재시도하고, 끝내 실패하면 network", async () => {
    const api = fakePlaceApi({ a: ["throw", "throw", "throw"] });
    expect(await fetchPlaceDetail(api.fetcher, "a", { budget: new Budget(5), sleep })).toEqual({ ok: false, reason: "network" });
  });

  it("R9: 4xx는 재시도하지 않는다", async () => {
    const api = fakePlaceApi({ a: [404, jungang] });
    expect(await fetchPlaceDetail(api.fetcher, "a", { budget: new Budget(5), sleep })).toEqual({ ok: false, reason: "http_404" });
    expect(api.calls).toHaveLength(1);
  });

  it("R10: 시도마다 예산을 쓰고, 예산이 없으면 budget", async () => {
    const api = fakePlaceApi({ a: [500, jungang] });
    const budget = new Budget(1);
    expect(await fetchPlaceDetail(api.fetcher, "a", { budget, sleep })).toEqual({ ok: false, reason: "budget" });
    expect(budget.left).toBe(0);
    expect(api.calls).toHaveLength(1);
  });

  it("R6: JSON이 아니면 schema", async () => {
    const r = await fetchPlaceDetail(async () => new Response("<html>"), "a", { budget: new Budget(5), sleep });
    expect(r).toEqual({ ok: false, reason: "schema" });
  });
});
