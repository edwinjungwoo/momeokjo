import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASEM } from "../../shared/constants";
import { tileKeyOf } from "../../shared/geo";
import { Budget } from "../../worker/budget";
import { enrichDetails } from "../../worker/detailEnricher";
import { getMeta, placeById, replaceTilePlaces } from "../../worker/repo";
import { fakePlaceApi } from "../helpers/fakeKakao";
import { placeJson } from "../helpers/places";

const NOW = 1_800_000_000_000;
const sleep = async () => {};
const seedIds = (ids: string[]) => replaceTilePlaces(env.DB, tileKeyOf(ASEM), ids, NOW, false);
const json = (name: string) => placeJson({ name, lat: ASEM.lat, lng: ASEM.lng });
const run = (fetcher: any, opts: { budget?: number; batchSize?: number } = {}) =>
  enrichDetails(
    { db: env.DB, fetcher, budget: new Budget(opts.budget ?? 40), now: NOW, batchSize: opts.batchSize ?? 10, sleep },
    ASEM,
    1000,
  );

describe("enrichDetails", () => {
  it("R10: 격자 거리순(같으면 id순)으로 batchSize만큼 보충하고 표시 정보를 저장한다", async () => {
    await seedIds(["1", "2", "3"]);
    const api = fakePlaceApi({ "1": json("가게1"), "2": json("가게2"), "3": json("가게3") });
    expect(await run(api.fetcher, { batchSize: 2 })).toEqual({ enriched: 2, failed: 0 });
    expect(api.calls.map((c) => c.id).sort()).toEqual(["1", "2"]);
    const row = (await placeById(env.DB, "1"))!;
    expect(row.place.name).toBe("가게1");
    expect(row.place.lat).toBe(ASEM.lat);
    expect(row.detail.rating).toBe(4.1);
    expect(await getMeta(env.DB, "3")).toBeNull();
  });

  it("R9: 실패는 사유와 함께 기록한다", async () => {
    await seedIds(["1"]);
    expect(await run(fakePlaceApi({ "1": 404 }).fetcher)).toEqual({ enriched: 0, failed: 1 });
    expect(await getMeta(env.DB, "1")).toEqual({ status: "failed", fetchedAt: NOW, reason: "http_404" });
  });

  it("R10: 예산이 떨어져서 못 한 장소는 실패로 기록하지 않는다", async () => {
    await seedIds(["1", "2", "3"]);
    const api = fakePlaceApi({ "1": json("a"), "2": json("b"), "3": json("c") });
    expect(await run(api.fetcher, { budget: 1 })).toEqual({ enriched: 1, failed: 0 });
    expect(await getMeta(env.DB, "2")).toBeNull();
    expect(await getMeta(env.DB, "3")).toBeNull();
  });

  it("R10: 403/429가 나오면 차단 신호로 보고 배치의 나머지를 시작하지 않는다", async () => {
    await seedIds(["1", "2", "3", "4", "5"]);
    const api = fakePlaceApi({ "1": 403, "2": 403, "3": 429, "4": json("d"), "5": json("e") });
    const r = await run(api.fetcher);
    expect(api.calls).toHaveLength(3);
    expect(r).toEqual({ enriched: 0, failed: 3 });
    expect(await getMeta(env.DB, "4")).toBeNull();
  });

  it("R10: 할 일이 없으면 외부 호출을 하지 않는다", async () => {
    const api = fakePlaceApi({});
    expect(await run(api.fetcher)).toEqual({ enriched: 0, failed: 0 });
    expect(api.calls).toHaveLength(0);
  });
});
