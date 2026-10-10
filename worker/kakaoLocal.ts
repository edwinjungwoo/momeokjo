import { z } from "zod";
import { categoryGroup } from "../shared/category";
import { KAKAO_PAGE_SIZE } from "../shared/constants";
import type { Place, Rect } from "../shared/types";
import { UPSTREAM_TIMEOUT_MS, UpstreamError, discardBody, type FetchFn } from "./fetchFn";

const DocSchema = z.object({
  id: z.string(),
  place_name: z.string(),
  category_name: z.string(),
  x: z.string(),
  y: z.string(),
  address_name: z.string().nullish(),
  road_address_name: z.string().nullish(),
  phone: z.string().nullish(),
  place_url: z.string(),
});

const ResponseSchema = z.object({
  meta: z.object({ total_count: z.number(), is_end: z.boolean() }),
  documents: z.array(DocSchema),
});

export type LocalPage = { totalCount: number; isEnd: boolean; places: Place[] };

export function parseLocalResponse(json: unknown): LocalPage | null {
  const r = ResponseSchema.safeParse(json);
  if (!r.success) return null;
  return {
    totalCount: r.data.meta.total_count,
    isEnd: r.data.meta.is_end,
    places: r.data.documents.map((d) => ({
      id: d.id,
      name: d.place_name,
      categoryName: d.category_name,
      group: categoryGroup(d.category_name),
      lat: Number(d.y),
      lng: Number(d.x),
      address: d.road_address_name || d.address_name || null,
      phone: d.phone || null,
      photoUrl: null,
      url: d.place_url,
    })),
  };
}

/** timeoutMs(기본 UPSTREAM_TIMEOUT_MS)가 지나면 끊고 UpstreamError(0, "network"). 성공이 아닌 응답의 본문은 버린다 */
export async function searchRect(
  fetcher: FetchFn, restKey: string, rect: Rect, page: number, timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<LocalPage> {
  const url = new URL("https://dapi.kakao.com/v2/local/search/category.json");
  url.searchParams.set("category_group_code", "FD6");
  url.searchParams.set("rect", `${rect.minLng},${rect.minLat},${rect.maxLng},${rect.maxLat}`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("size", String(KAKAO_PAGE_SIZE));
  url.searchParams.set("sort", "accuracy");
  let res: Response;
  try {
    res = await fetcher(url.toString(), { headers: { Authorization: `KakaoAK ${restKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new UpstreamError(0, "network");
  }
  if (!res.ok) {
    discardBody(res);
    throw new UpstreamError(res.status);
  }
  const page_ = parseLocalResponse(await res.json().catch(() => null));
  if (!page_) throw new UpstreamError(res.status, "schema");
  return page_;
}
