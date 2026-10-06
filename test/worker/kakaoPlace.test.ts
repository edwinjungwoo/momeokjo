import { describe, expect, it } from "vitest";
import { Budget } from "../../worker/budget";
import { parseDetail } from "../../worker/detailParser";
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

  it("R10: 본문을 글자로 읽어 JSON으로 풀어도 res.json()과 결과가 같고(BOM·빈 본문·깨진 JSON·잘못된 UTF-8), 읽은 글자 수를 onBody로 알린다", async () => {
    const enc = new TextEncoder();
    const text = JSON.stringify(jungang);
    const badUtf8 = enc.encode(text.replace('"name":"', '"name":"\u0000'));
    badUtf8[badUtf8.indexOf(0)] = 0xff; // 이름 첫 바이트를 잘못된 UTF-8로
    const bodies: Uint8Array[] = [
      enc.encode(text),
      enc.encode(`﻿${text}`),
      enc.encode(`  \n${text}\n `),
      enc.encode(""),
      enc.encode("{bad"),
      enc.encode("null"),
      enc.encode("[]"),
      badUtf8,
    ];
    for (const body of bodies) {
      // 예전 길: res.json() → parseDetail
      let expected: unknown;
      try {
        const parsed = parseDetail(await new Response(body).json());
        expected = parsed.ok ? parsed : { ok: false, reason: parsed.reason };
      } catch {
        expected = { ok: false, reason: "schema" };
      }
      const seen: number[] = [];
      const r = await fetchPlaceDetail(async () => new Response(body), "a", {
        budget: new Budget(5), sleep, onBody: (n) => seen.push(n),
      });
      expect(r).toEqual(expected);
      expect(seen).toEqual([new TextDecoder().decode(body).length]);
    }
  });

  it("R10: 실패 응답(4xx·5xx·네트워크)은 본문을 읽지 않아 onBody가 불리지 않는다", async () => {
    const seen: number[] = [];
    const api = fakePlaceApi({ a: [500, 500, 500], b: 404, c: ["throw", "throw", "throw"] });
    for (const id of ["a", "b", "c"]) {
      await fetchPlaceDetail(api.fetcher, id, { budget: new Budget(5), sleep, onBody: (n) => seen.push(n) });
    }
    expect(seen).toEqual([]);
  });
});
