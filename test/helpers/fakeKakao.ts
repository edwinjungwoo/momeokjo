import type { FetchFn } from "../../worker/fetchFn";
import type { Rect } from "../../shared/types";

export type FakeDoc = {
  id: string;
  place_name: string;
  category_name: string;
  x: string;
  y: string;
  address_name: string;
  road_address_name: string;
  phone: string;
  place_url: string;
};

export function doc(id: string, lat: number, lng: number, category = "음식점 > 한식"): FakeDoc {
  return {
    id,
    place_name: `가게${id}`,
    category_name: category,
    x: String(lng),
    y: String(lat),
    address_name: "서울 강남구 삼성동 1",
    road_address_name: "서울 강남구 영동대로 1",
    phone: "02-000-0000",
    place_url: `http://place.map.kakao.com/${id}`,
  };
}

/** rect 내부(경계 제외)에 n개를 격자 모양으로 흩뿌린다 */
export function gridDocs(prefix: string, n: number, rect: Rect, category?: string): FakeDoc[] {
  const side = Math.ceil(Math.sqrt(n));
  return Array.from({ length: n }, (_, k) => {
    const row = Math.floor(k / side);
    const col = k % side;
    const lat = rect.minLat + ((row + 0.5) / side) * (rect.maxLat - rect.minLat);
    const lng = rect.minLng + ((col + 0.5) / side) * (rect.maxLng - rect.minLng);
    return doc(`${prefix}${k}`, lat, lng, category);
  });
}

const urlOf = (input: RequestInfo | URL) =>
  new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

/** 카카오 로컬 rect 검색 흉내: 최대 45개, 15개씩 3페이지, total_count는 실제 개수 */
export function fakeKakaoLocal(docs: FakeDoc[], opts: { status?: number } = {}) {
  const calls: URL[] = [];
  const fetcher: FetchFn = async (input) => {
    const url = urlOf(input);
    calls.push(url);
    if (opts.status) return new Response("error", { status: opts.status });
    const [minLng, minLat, maxLng, maxLat] = url.searchParams.get("rect")!.split(",").map(Number);
    const inRect = docs.filter((d) => +d.x >= minLng && +d.x <= maxLng && +d.y >= minLat && +d.y <= maxLat);
    const page = Number(url.searchParams.get("page") ?? "1");
    const pageable = inRect.slice(0, 45);
    const documents = pageable.slice((page - 1) * 15, page * 15);
    return Response.json({
      meta: { total_count: inRect.length, pageable_count: pageable.length, is_end: page * 15 >= pageable.length },
      documents,
    });
  };
  return { fetcher, calls };
}

type PlaceResponse = unknown | number | "throw";

/** 비공식 상세 API 흉내: id → JSON 본문 | 상태 코드 | "throw" | 순서대로 쓸 배열 */
export function fakePlaceApi(responses: Record<string, PlaceResponse | PlaceResponse[]>) {
  const calls: { id: string; headers: Headers }[] = [];
  const fetcher: FetchFn = async (input, init) => {
    const url = urlOf(input);
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    calls.push({ id, headers: new Headers(init?.headers) });
    const entry = responses[id];
    const r = Array.isArray(entry) ? entry.shift() : entry;
    if (r === undefined) return new Response("not found", { status: 404 });
    if (r === "throw") throw new TypeError("network down");
    if (typeof r === "number") return new Response("error", { status: r });
    return Response.json(r);
  };
  return { fetcher, calls };
}

export function routeFetch(local: FetchFn, place: FetchFn): FetchFn {
  return (input, init) => (urlOf(input).hostname === "dapi.kakao.com" ? local(input, init) : place(input, init));
}
