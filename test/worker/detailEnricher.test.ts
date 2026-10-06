import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASEM, DETAIL_JITTER_MS, DETAIL_OK_TTL_MS, PLACE_BLOCK_COOLDOWN_MS } from "../../shared/constants";
import { tileKeyOf } from "../../shared/geo";
import { Budget } from "../../worker/budget";
import { DETAIL_CONCURRENCY, enrichDetails } from "../../worker/detailEnricher";
import { detailGate, getMeta, placeById, recordPlaceBlock, replaceTilePlaces } from "../../worker/repo";
import { fakePlaceApi } from "../helpers/fakeKakao";
import { placeJson, seedPlace } from "../helpers/places";

const NOW = 1_800_000_000_000;
const sleep = async () => {};
const seedIds = (ids: string[]) => replaceTilePlaces(env.DB, tileKeyOf(ASEM), ids, NOW, false);
const json = (name: string) => placeJson({ name, lat: ASEM.lat, lng: ASEM.lng });
const run = (
  fetcher: any,
  opts: { budget?: number; batchSize?: number; now?: number; scope?: "due" | "unfetched"; charBudget?: number; db?: D1Database } = {},
) =>
  enrichDetails(
    {
      db: opts.db ?? env.DB, fetcher, budget: new Budget(opts.budget ?? 40), now: opts.now ?? NOW, batchSize: opts.batchSize ?? 10,
      sleep, scope: opts.scope, charBudget: opts.charBudget,
    },
    ASEM,
    1000,
  );

describe("enrichDetails", () => {
  it("R10: 격자 거리순(같으면 id순)으로 batchSize만큼 보충하고 표시 정보를 저장한다", async () => {
    await seedIds(["1", "2", "3"]);
    const api = fakePlaceApi({ "1": json("가게1"), "2": json("가게2"), "3": json("가게3") });
    expect(await run(api.fetcher, { batchSize: 2 })).toEqual({ enriched: 2, failed: 0, deferred: 0 });
    expect(api.calls.map((c) => c.id).sort()).toEqual(["1", "2"]);
    const row = (await placeById(env.DB, "1"))!;
    expect(row.place.name).toBe("가게1");
    expect(row.place.lat).toBe(ASEM.lat);
    expect(row.detail.rating).toBe(4.1);
    expect(await getMeta(env.DB, "3")).toBeNull();
  });

  it("R9: 실패는 사유와 함께 기록한다", async () => {
    await seedIds(["1"]);
    expect(await run(fakePlaceApi({ "1": 404 }).fetcher)).toEqual({ enriched: 0, failed: 1, deferred: 0 });
    expect(await getMeta(env.DB, "1")).toEqual({ status: "failed", fetchedAt: NOW, reason: "http_404" });
  });

  it("R10: 예산이 떨어져서 못 한 장소는 실패로 기록하지 않는다", async () => {
    await seedIds(["1", "2", "3"]);
    const api = fakePlaceApi({ "1": json("a"), "2": json("b"), "3": json("c") });
    expect(await run(api.fetcher, { budget: 1 })).toEqual({ enriched: 1, failed: 0, deferred: 0 });
    expect(await getMeta(env.DB, "2")).toBeNull();
    expect(await getMeta(env.DB, "3")).toBeNull();
  });

  it("R10: 403/429가 나오면 차단 신호로 보고 배치의 나머지를 시작하지 않는다", async () => {
    await seedIds(["1", "2", "3", "4", "5"]);
    const api = fakePlaceApi({ "1": 403, "2": 403, "3": 429, "4": json("d"), "5": json("e") });
    const r = await run(api.fetcher);
    expect(api.calls).toHaveLength(3);
    expect(r).toEqual({ enriched: 0, failed: 3, deferred: 0 });
    expect(await getMeta(env.DB, "4")).toBeNull();
  });

  it("R10: 403/429가 나오면 30분 동안 전체 상세 호출을 멈추는 쿨다운을 기록한다", async () => {
    await seedIds(["1"]);
    await run(fakePlaceApi({ "1": 429 }).fetcher);
    expect((await detailGate(env.DB)).blockedUntil).toBe(NOW + PLACE_BLOCK_COOLDOWN_MS);
  });

  it("R10: 쿨다운 중에는 외부 호출을 하지 않고, 지나면 다시 보충한다", async () => {
    await seedIds(["1"]);
    await recordPlaceBlock(env.DB, NOW);
    const api = fakePlaceApi({ "1": json("a") });
    expect(await run(api.fetcher, { now: NOW + PLACE_BLOCK_COOLDOWN_MS - 1 })).toEqual({ enriched: 0, failed: 0, deferred: 0 });
    expect(api.calls).toHaveLength(0);
    expect(await run(api.fetcher, { now: NOW + PLACE_BLOCK_COOLDOWN_MS })).toEqual({ enriched: 1, failed: 0, deferred: 0 });
  });

  it("R12: scope=unfetched면 한 번도 가져오지 않은 ID만 보충한다 (만료된 행 갱신은 Cron 몫)", async () => {
    await seedIds(["old", "new"]);
    await seedPlace(env.DB, "old", ASEM.lat, ASEM.lng, { now: NOW - DETAIL_OK_TTL_MS - DETAIL_JITTER_MS });
    const api = fakePlaceApi({ old: json("old"), new: json("new") });
    expect(await run(api.fetcher, { scope: "unfetched" })).toEqual({ enriched: 1, failed: 0, deferred: 0 });
    expect(api.calls.map((c) => c.id)).toEqual(["new"]);
    expect(await run(api.fetcher)).toEqual({ enriched: 1, failed: 0, deferred: 0 });
    expect(api.calls.map((c) => c.id)).toEqual(["new", "old"]);
  });

  it("R10: 할 일이 없으면 외부 호출을 하지 않는다", async () => {
    const api = fakePlaceApi({});
    expect(await run(api.fetcher)).toEqual({ enriched: 0, failed: 0, deferred: 0 });
    expect(api.calls).toHaveLength(0);
  });

  it("R10: 상세 JSON 글자 예산(charBudget)을 다 쓰면 새 상세를 시작하지 않고 남긴다 — 이미 시작한 곳(동시 3곳)은 끝내고, 남긴 곳은 실패로 기록하지 않는다", async () => {
    const ids = ["1", "2", "3", "4", "5", "6"];
    await seedIds(ids);
    const api = fakePlaceApi(Object.fromEntries(ids.map((id) => [id, json(`가게${id}`)])));
    // 1글자 예산: 처음 동시에 시작한 곳들만 하고 나머지는 남긴다 (언제나 적어도 한 곳은 한다)
    expect(await run(api.fetcher, { charBudget: 1 })).toEqual({ enriched: DETAIL_CONCURRENCY, failed: 0, deferred: ids.length - DETAIL_CONCURRENCY });
    expect(api.calls).toHaveLength(DETAIL_CONCURRENCY);
    expect(await getMeta(env.DB, "6")).toBeNull();
    // 남긴 곳은 다음 실행이 가까운 순서대로 이어 한다
    expect(await run(api.fetcher, { charBudget: 1 })).toEqual({ enriched: 3, failed: 0, deferred: 0 });
    expect(new Set(api.calls.map((c) => c.id))).toEqual(new Set(ids));
  });

  it("R10: 글자 예산은 읽은 본문 글자 수로 센다 — 두 곳 분량이면 그만큼 읽은 뒤에는 시작하지 않는다", async () => {
    const ids = ["1", "2", "3", "4", "5", "6", "7"];
    await seedIds(ids);
    const body = JSON.stringify(json("가게"));
    const api = fakePlaceApi(Object.fromEntries(ids.map((id) => [id, json("가게")])));
    // 새 상세는 읽은 글자가 두 곳 분량보다 적을 때만 시작한다 — 끝난 곳 ≤ 1일 때 시작하므로 많아야 1 + 동시 수만큼
    const r = await run(api.fetcher, { charBudget: body.length * 2 });
    expect(r.enriched).toBeGreaterThanOrEqual(2);
    expect(r.enriched).toBeLessThanOrEqual(1 + DETAIL_CONCURRENCY);
    expect(r).toEqual({ enriched: r.enriched, failed: 0, deferred: ids.length - r.enriched });
    expect(api.calls).toHaveLength(r.enriched);
    // 예산이 넉넉하면 batchSize만큼 (남은 곳 전부)
    expect(await run(api.fetcher, { charBudget: body.length * 100 })).toEqual({ enriched: ids.length - r.enriched, failed: 0, deferred: 0 });
  });

  it("R10/R56: 한 번의 보충은 결과(상세·실패)를 D1 batch 하나로 저장한다", async () => {
    await seedIds(["1", "2", "3", "4"]);
    const api = fakePlaceApi({ "1": json("a"), "2": 404, "3": json("c"), "4": json("d") });
    const batches: number[] = [];
    const db = new Proxy(env.DB, {
      get(t, k) {
        if (k === "batch") return async (st: D1PreparedStatement[]) => { batches.push(st.length); return t.batch(st); };
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    expect(await run(api.fetcher, { db })).toEqual({ enriched: 3, failed: 1, deferred: 0 });
    expect(batches).toEqual([1 + 4]); // 거점 표시 1 + 4곳
    expect((await placeById(env.DB, "3"))!.place.name).toBe("c");
    expect(await getMeta(env.DB, "2")).toEqual({ status: "failed", fetchedAt: NOW, reason: "http_404" });
  });
});
