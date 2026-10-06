import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPlaces } from "../../web/api";

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
