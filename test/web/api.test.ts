import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlacesResponse } from "../../shared/types";
import { fetchPlaces, loadPlaces } from "../../web/api";

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
