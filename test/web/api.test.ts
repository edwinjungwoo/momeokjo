import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlacesResponse } from "../../shared/types";
import { RESPONSE_TIMEOUT_MS, fetchPlace, fetchPlaces, fetchWithTimeout, isNotFound, loadPlaces } from "../../web/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(res: () => Response) {
  const calls: { url: string; headers: Headers }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return res();
  });
  return calls;
}

describe("R56 목록 요청의 ETag", () => {
  it("R56: 기기 저장본의 ETag가 있으면 If-None-Match로 보내고, 304면 본문 없이 notModified", async () => {
    const calls = stubFetch(() => new Response(null, { status: 304, headers: { etag: 'W/"1-ddp-abc"' } }));
    const r = await fetchPlaces("ddp", 1000, undefined, 'W/"1-ddp-abc"');
    expect(r).toEqual({ notModified: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/places?hub=ddp&radius=1000");
    expect(calls[0].headers.get("if-none-match")).toBe('W/"1-ddp-abc"');
  });

  it("R56: ETag가 없으면 조건 없이 받고, 응답의 ETag를 돌려준다 (없으면 null)", async () => {
    const body = '{"places":[],"pending":0}';
    const calls = stubFetch(() => new Response(body, { status: 200, headers: { etag: 'W/"1-ddp-def"' } }));
    const r = await fetchPlaces("ddp", 1000);
    expect(calls[0].headers.has("if-none-match")).toBe(false);
    expect(r).toEqual({ notModified: false, data: JSON.parse(body), text: body, etag: 'W/"1-ddp-def"' });
    stubFetch(() => new Response(body, { status: 200 }));
    expect(await fetchPlaces("ddp", 1000, undefined, null)).toMatchObject({ notModified: false, etag: null });
  });

  it("R56: 오류 응답은 그대로 실패", async () => {
    stubFetch(() => new Response("x", { status: 502 }));
    await expect(fetchPlaces("ddp", 1000, undefined, 'W/"x"')).rejects.toThrow("places 502");
  });
});

describe("R56 다시 열 때 — 저장본 해석을 기다리지 않고 요청", () => {
  const copy = { data: { places: [] } as unknown as PlacesResponse, text: '{"places":[]}', etag: 'W/"1-ddp-abc"' };

  it("R56: 저장본(1MB 해석)을 기다리지 않고 ETag로 바로 요청하고, 304면 저장본을 새 목록으로 쓴다", async () => {
    const calls = stubFetch(() => new Response(null, { status: 304 }));
    let release!: (v: typeof copy) => void;
    const pending = new Promise<typeof copy>((r) => (release = r));
    const result = loadPlaces("ddp", 1000, undefined, 'W/"1-ddp-abc"', () => pending);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.get("if-none-match")).toBe('W/"1-ddp-abc"');
    release(copy);
    expect(await result).toEqual({ data: copy.data, text: copy.text, etag: copy.etag, fromCopy: true });
  });

  it("R56: 304인데 저장본이 없거나 ETag가 다르면 조건 없이 다시 받는다", async () => {
    const body = '{"places":[1]}';
    for (const saved of [null, { ...copy, etag: 'W/"other"' }]) {
      let n = 0;
      const calls = stubFetch(() =>
        n++ === 0 ? new Response(null, { status: 304 }) : new Response(body, { headers: { etag: 'W/"2"' } }),
      );
      const r = await loadPlaces("ddp", 1000, undefined, 'W/"1-ddp-abc"', async () => saved);
      expect(r).toEqual({ data: JSON.parse(body), text: body, etag: 'W/"2"', fromCopy: false });
      expect(calls).toHaveLength(2);
      expect(calls[1].headers.has("if-none-match")).toBe(false);
    }
  });

  it("R56: ETag가 없으면 저장본을 보지 않고 받는다", async () => {
    const body = '{"places":[]}';
    stubFetch(() => new Response(body));
    let asked = false;
    const r = await loadPlaces("ddp", 1000, undefined, null, async () => ((asked = true), copy));
    expect(r).toMatchObject({ text: body, fromCopy: false, etag: null });
    expect(asked).toBe(false);
  });
});

describe("R29/R65 느리거나 끊긴 연결", () => {
  /** 응답하지 않는 연결 (사내 Wi-Fi 로그인 화면, 끊긴 LTE): signal이 끊어야만 끝난다 */
  const hang = () =>
    vi.stubGlobal("fetch", (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))));

  it("R29: 응답(헤더)이 시간 안에 오지 않으면 끊고 실패 — 화면은 오류와 다시 시도로 간다 (기본 15초)", async () => {
    hang();
    expect(RESPONSE_TIMEOUT_MS).toBe(15_000);
    await expect(fetchWithTimeout("/api/places?hub=ddp&radius=1000", {}, 20)).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("R29: 부른 쪽이 멈추면(거점 바꿈) 그대로 멈추고, 응답이 오면 시간 초과는 풀린다 (느린 본문 받기는 끊지 않는다)", async () => {
    hang();
    const ctrl = new AbortController();
    const p = fetchWithTimeout("/x", { signal: ctrl.signal }, 10_000);
    ctrl.abort();
    await expect(p).rejects.toBeDefined();
    let seen: AbortSignal | undefined;
    vi.stubGlobal("fetch", async (_: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Response("{}");
    });
    await fetchWithTimeout("/x", {}, 20);
    await new Promise((r) => setTimeout(r, 40));
    expect(seen?.aborted).toBe(false);
  });

  it("R65: 단건이 없음(404)일 때만 '못 찾음' — 오프라인·429·5xx는 다음에 다시 부른다", async () => {
    stubFetch(() => new Response("x", { status: 404 }));
    const missing = await fetchPlace("123").catch((e) => e);
    expect(isNotFound(missing)).toBe(true);
    stubFetch(() => new Response("x", { status: 429 }));
    expect(isNotFound(await fetchPlace("123").catch((e) => e))).toBe(false);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(isNotFound(await fetchPlace("123").catch((e) => e))).toBe(false);
  });
});
