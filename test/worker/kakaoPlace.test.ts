import { describe, expect, it } from "vitest";
import { Budget } from "../../worker/budget";
import { parseDetail } from "../../worker/detailParser";
import { fetchPlaceDetail } from "../../worker/kakaoPlace";
import { UPSTREAM_TIMEOUT_MS } from "../../worker/fetchFn";
import jungang from "../fixtures/place-detail/27531028-jungang-haejang.json";
import { fakePlaceApi } from "../helpers/fakeKakao";

const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };

/** 응답하지 않는 서버 흉내 (막힌 대신 붙잡아 두는 차단): 요청의 signal이 끊어야만 끝난다 */
const hanging = () => {
  let calls = 0;
  const fetcher = (_: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
  };
  return { fetcher, calls: () => calls };
};
/** 본문을 읽지 않고 버리면(cancel) 센다 */
const tracked = (status: number) => {
  let cancelled = 0;
  const res = () =>
    new Response(new ReadableStream({ pull: (c) => c.enqueue(new TextEncoder().encode("x")), cancel: () => void (cancelled += 1) }), { status });
  return { res, cancelled: () => cancelled };
};

describe("fetchPlaceDetail", () => {
  it("R9/R10: 응답이 오지 않으면 시간 초과(기본 10초)로 끊고 network로 재시도·실패한다 — 붙잡아 두는 차단에 실행이 CPU·시간 한도까지 매달리지 않는다", async () => {
    sleeps.length = 0;
    const api = hanging();
    expect(await fetchPlaceDetail(api.fetcher, "a", { budget: new Budget(5), sleep, timeoutMs: 20 })).toEqual({ ok: false, reason: "network" });
    expect(api.calls()).toBe(3);
    expect(UPSTREAM_TIMEOUT_MS).toBe(10_000);
  });

  it("R9: 성공이 아닌 응답의 본문은 읽지 않고 버린다 (재시도 전에도 — 동시 연결 6개를 붙잡지 않게)", async () => {
    const t = tracked(503);
    const r = await fetchPlaceDetail(async () => t.res(), "a", { budget: new Budget(5), sleep });
    expect(r).toEqual({ ok: false, reason: "http_503" });
    expect(t.cancelled()).toBe(3);
    const nf = tracked(404);
    expect(await fetchPlaceDetail(async () => nf.res(), "a", { budget: new Budget(5), sleep })).toEqual({ ok: false, reason: "http_404" });
    expect(nf.cancelled()).toBe(1);
  });

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

  it("R9: 네트워크 오류도 재시도하고(같은 백오프, 모두 3번), 끝내 실패하면 network", async () => {
    sleeps.length = 0;
    const api = fakePlaceApi({ a: ["throw", "throw", "throw"] });
    expect(await fetchPlaceDetail(api.fetcher, "a", { budget: new Budget(5), sleep })).toEqual({ ok: false, reason: "network" });
    expect(api.calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 1000]);
  });

  it("R9: 4xx는 재시도하지 않는다", async () => {
    const api = fakePlaceApi({ a: [404, jungang] });
    expect(await fetchPlaceDetail(api.fetcher, "a", { budget: new Budget(5), sleep })).toEqual({ ok: false, reason: "http_404" });
    expect(api.calls).toHaveLength(1);
  });

  it("R9/R10: 403·429도 재시도하지 않는다 — 차단 신호라서 더 두드리지 않고 부르는 쪽이 쿨다운을 건다", async () => {
    for (const status of [403, 429]) {
      const api = fakePlaceApi({ a: [status, jungang] });
      expect(await fetchPlaceDetail(api.fetcher, "a", { budget: new Budget(5), sleep })).toEqual({ ok: false, reason: `http_${status}` });
      expect(api.calls, String(status)).toHaveLength(1);
    }
  });

  it("infra: 가짜 상세 API는 넘긴 응답 배열을 바꾸지 않는다 (같은 응답 목록으로 가짜를 여럿 만들어도 같다)", async () => {
    const responses = { a: [500, jungang] };
    for (let i = 0; i < 2; i++) {
      const api = fakePlaceApi(responses);
      expect((await fetchPlaceDetail(api.fetcher, "a", { budget: new Budget(5), sleep })).ok).toBe(true);
      expect(api.calls).toHaveLength(2);
    }
    expect(responses.a).toEqual([500, jungang]);
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
