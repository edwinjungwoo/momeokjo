import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASEM, TILE_TTL_MS } from "../../shared/constants";
import { splitRect, tileKeyOf, tileRect, tilesCoveringCircle } from "../../shared/geo";
import { Budget } from "../../worker/budget";
import { getTiles, markTile, tilePlaceStates } from "../../worker/repo";
import { collectTiles } from "../../worker/tileCollector";
import { tileFreshFrom } from "../../worker/refreshSchedule";
import { doc, fakeKakaoLocal, gridDocs } from "../helpers/fakeKakao";

const NOW = 1_800_000_000_000;
const KEY = tileKeyOf(ASEM);
const RECT = tileRect(KEY);
const deps = (fetcher: any, budget = 40) => ({ db: env.DB, fetcher, restKey: "k", budget: new Budget(budget), now: NOW });
const idCount = async () => new Set((await tilePlaceStates(env.DB, [KEY])).map((t) => t.id)).size;

describe("collectTiles", () => {
  it("R2: 45개 이하면 페이지만 넘겨서 ID를 기록한다 (30개 → 호출 2번)", async () => {
    const kakao = fakeKakaoLocal(gridDocs("a", 30, RECT));
    const r = await collectTiles(deps(kakao.fetcher), [KEY]);
    expect(r).toEqual({ collected: [KEY], incomplete: [], failed: [] });
    expect(kakao.calls).toHaveLength(2);
    expect(await idCount()).toBe(30);
    expect((await getTiles(env.DB, [KEY])).get(KEY)).toEqual({ collectedAt: NOW, saturated: false });
  });

  it("R2: 로컬 API 응답 내용(이름, 좌표, 카테고리)은 저장하지 않는다", async () => {
    const kakao = fakeKakaoLocal(gridDocs("p", 10, RECT));
    await collectTiles(deps(kakao.fetcher), [KEY]);
    const r = await env.DB.prepare("SELECT count(*) AS c FROM places").first<{ c: number }>();
    expect(r?.c).toBe(0);
  });

  it("R2: 45개를 넘으면 4등분해서 빠짐없이 기록한다 (100개)", async () => {
    const kakao = fakeKakaoLocal(gridDocs("b", 100, RECT));
    expect((await collectTiles(deps(kakao.fetcher), [KEY])).collected).toEqual([KEY]);
    expect(await idCount()).toBe(100);
    expect((await getTiles(env.DB, [KEY])).get(KEY)?.saturated).toBe(false);
  });

  it("R2: 최대 깊이에서도 45개를 넘으면 45개만 기록하고 saturated로 표시한다", async () => {
    const same = Array.from({ length: 50 }, (_, i) => doc(`s${i}`, ASEM.lat, ASEM.lng));
    await collectTiles(deps(fakeKakaoLocal(same).fetcher, 100), [KEY]);
    expect(await idCount()).toBe(45);
    expect((await getTiles(env.DB, [KEY])).get(KEY)?.saturated).toBe(true);
  });

  it("R2: 깊이 4 칸에 46곳 넘게 몰려도 깊이 5에서 45곳 이하로 나뉘면 saturated가 아니고 ID를 빠짐없이 기록한다 (한 건물에 몰린 가게)", async () => {
    // 격자를 깊이 4까지 내려간 칸 하나(약 15m)에 50곳: 깊이 5 하위 칸에는 40 / 10곳
    let cell = RECT;
    for (let d = 0; d < 4; d++) cell = splitRect(cell)[3];
    const [, subA, subB] = splitRect(cell);
    const docs = [...gridDocs("big", 40, subA), ...gridDocs("small", 10, subB)];
    const kakao = fakeKakaoLocal(docs);
    const r = await collectTiles(deps(kakao.fetcher, 100), [KEY]);
    expect(r).toEqual({ collected: [KEY], incomplete: [], failed: [] });
    expect(await idCount()).toBe(50);
    expect((await getTiles(env.DB, [KEY])).get(KEY)).toEqual({ collectedAt: NOW, saturated: false });
  });

  it("R2/R5: 간식(디저트) 업종은 ID도 기록하지 않는다", async () => {
    const docs = [
      ...gridDocs("f", 7, RECT),
      ...gridDocs("d", 3, RECT, "음식점 > 간식 > 제과,베이커리"),
    ];
    await collectTiles(deps(fakeKakaoLocal(docs).fetcher), [KEY]);
    const ids = (await tilePlaceStates(env.DB, [KEY])).map((t) => t.id);
    expect(ids).toHaveLength(7);
    expect(ids.some((id) => id.startsWith("d"))).toBe(false);
  });

  it("R3/R63: 이번 갱신 시작 뒤에 수집한 거점 격자는 건너뛴다 (거점 밖은 7일 — repo.test.ts)", async () => {
    expect(tileFreshFrom(KEY, NOW)).toBeGreaterThan(NOW - TILE_TTL_MS);
    await markTile(env.DB, KEY, tileFreshFrom(KEY, NOW), 0, false);
    const kakao = fakeKakaoLocal(gridDocs("c", 10, RECT));
    expect(await collectTiles(deps(kakao.fetcher), [KEY])).toEqual({ collected: [], incomplete: [], failed: [] });
    expect(kakao.calls).toHaveLength(0);
  });

  it("R3/R4: 7일이 지나면 다시 수집하고 ID 목록을 새 결과로 바꾼다", async () => {
    await collectTiles(deps(fakeKakaoLocal(gridDocs("old", 30, RECT)).fetcher), [KEY]);
    const later = { ...deps(fakeKakaoLocal(gridDocs("new", 20, RECT)).fetcher), now: NOW + TILE_TTL_MS };
    expect((await collectTiles(later, [KEY])).collected).toEqual([KEY]);
    const ids = (await tilePlaceStates(env.DB, [KEY])).map((t) => t.id);
    expect(ids).toHaveLength(20);
    expect(ids.every((id) => id.startsWith("new"))).toBe(true);
  });

  it("R10: 예산이 부족하면 격자를 incomplete로 남기고 기록하지 않는다", async () => {
    const kakao = fakeKakaoLocal(gridDocs("d", 100, RECT));
    const r = await collectTiles(deps(kakao.fetcher, 2), [KEY, "1:1"]);
    expect(r).toEqual({ collected: [], incomplete: [KEY, "1:1"], failed: [] });
    expect((await getTiles(env.DB, [KEY])).has(KEY)).toBe(false);
    expect(kakao.calls.length).toBeLessThanOrEqual(2);
  });

  it("R10/F-4: 모든 사각형이 포화(46개)여도 외부 호출은 예산 40을 넘지 않고, 못 끝낸 격자는 incomplete로 남긴다", async () => {
    let calls = 0;
    const saturatedEverywhere = async () => {
      calls += 1;
      return Response.json({ meta: { total_count: 46, pageable_count: 45, is_end: false }, documents: [] });
    };
    const keys = tilesCoveringCircle(ASEM, 1000);
    const r = await collectTiles(deps(saturatedEverywhere, 40), keys);
    expect(calls).toBeLessThanOrEqual(40);
    expect(r.incomplete.length).toBeGreaterThan(0);
    expect(r.collected.length + r.incomplete.length + r.failed.length).toBe(keys.length);
    expect((await getTiles(env.DB, r.incomplete)).size).toBe(0);
  });

  it("R14: 공식 API 오류가 난 격자는 failed, 기록하지 않는다", async () => {
    const r = await collectTiles(deps(fakeKakaoLocal([], { status: 500 }).fetcher), [KEY]);
    expect(r).toEqual({ collected: [], incomplete: [], failed: [KEY] });
    expect((await getTiles(env.DB, [KEY])).has(KEY)).toBe(false);
  });
});
