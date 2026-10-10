import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WEEK_MS, detailFingerprint } from "../../shared/adaptiveRefresh";
import { ASEM } from "../../shared/constants";
import { saveDetail, saveDetailFailure, saveDetails } from "../../worker/repo";
import { makeSummary, sampleDetail } from "../helpers/places";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;
const S = makeSummary(ASEM.lat, ASEM.lng, { name: "가게" });

/** 저장된 R66 열 */
async function adaptive(id: string) {
  return env.DB.prepare("SELECT interval_weeks AS w, fp, due_after AS dueAfter, fetched_at AS fetchedAt, status FROM places WHERE id = ?")
    .bind(id)
    .first<{ w: number; fp: string | null; dueAfter: number | null; fetchedAt: number; status: string }>();
}

describe("R66 0008 마이그레이션", () => {
  it("R66: places에 interval_weeks(기본 1)·fp·due_after 열과 (status, due_after) 인덱스가 있다", async () => {
    const cols = (await env.DB.prepare("PRAGMA table_info(places)").all<{ name: string; dflt_value: string | null; notnull: number }>()).results;
    const w = cols.find((c) => c.name === "interval_weeks");
    expect(w).toMatchObject({ notnull: 1, dflt_value: "1" });
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["fp", "due_after"]));
    const idx = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_places_status_due'").first<{ sql: string }>();
    expect(idx?.sql).toMatch(/places\s*\(\s*status\s*,\s*due_after\s*\)/);
  });
});

describe("R66 상세 저장 — 지문과 주기", () => {
  it("R66: 처음 저장은 주기 1, 지문이 같으면 2 → 4 → 4, 다르면 1 — due_after = 가져온 시각 + (주기 − 1) × 7일", async () => {
    const d = sampleDetail();
    const fp = detailFingerprint(S, d);
    await saveDetail(env.DB, "1", S, d, NOW);
    expect(await adaptive("1")).toMatchObject({ w: 1, fp, dueAfter: NOW, fetchedAt: NOW });
    await saveDetail(env.DB, "1", S, d, NOW + 7 * DAY);
    expect(await adaptive("1")).toMatchObject({ w: 2, fp, dueAfter: NOW + 7 * DAY + WEEK_MS });
    await saveDetail(env.DB, "1", S, sampleDetail({ reviewCount: 999 }), NOW + 14 * DAY); // 리뷰 수만 바뀜 = 같음
    expect(await adaptive("1")).toMatchObject({ w: 4, fp, dueAfter: NOW + 14 * DAY + 3 * WEEK_MS });
    await saveDetail(env.DB, "1", S, d, NOW + 35 * DAY);
    expect(await adaptive("1")).toMatchObject({ w: 4, dueAfter: NOW + 35 * DAY + 3 * WEEK_MS });
    const changed = sampleDetail({ price: 15000 });
    await saveDetail(env.DB, "1", S, changed, NOW + 63 * DAY);
    expect(await adaptive("1")).toMatchObject({ w: 1, fp: detailFingerprint(S, changed), dueAfter: NOW + 63 * DAY });
  });

  it("R66/R9: 실패는 주기·지문·due_after를 바꾸지 않는다 — 다음 성공은 실패 전 지문과 비교한다", async () => {
    const d = sampleDetail();
    await saveDetail(env.DB, "1", S, d, NOW);
    await saveDetail(env.DB, "1", S, d, NOW + 7 * DAY); // 2주
    const before = await adaptive("1");
    await saveDetailFailure(env.DB, "1", "http_500", NOW + 21 * DAY);
    expect(await adaptive("1")).toMatchObject({ status: "failed", w: before!.w, fp: before!.fp, dueAfter: before!.dueAfter, fetchedAt: NOW + 21 * DAY });
    await saveDetail(env.DB, "1", S, d, NOW + 22 * DAY);
    expect(await adaptive("1")).toMatchObject({ status: "ok", w: 4, dueAfter: NOW + 22 * DAY + 3 * WEEK_MS });
  });

  it("R66: 마이그레이션 전 행(지문 없음)과 한 번도 성공하지 못한 행은 처음처럼 주기 1에서 시작한다", async () => {
    await env.DB.prepare(
      "INSERT INTO places (id, status, name, lat, lng, fetched_at, interval_weeks) VALUES ('old', 'ok', '예전', 37.5, 127.0, ?, 4)",
    ).bind(NOW - 30 * DAY).run();
    await saveDetailFailure(env.DB, "never", "http_500", NOW - DAY);
    await saveDetail(env.DB, "old", S, sampleDetail(), NOW);
    await saveDetail(env.DB, "never", S, sampleDetail(), NOW);
    expect(await adaptive("old")).toMatchObject({ w: 1, dueAfter: NOW });
    expect(await adaptive("never")).toMatchObject({ w: 1, dueAfter: NOW });
  });

  it("R66: 열어 본 가게의 저장(weekly)은 지문이 같아도 주기 1로 둔다 — 묶음 저장(saveDetails)도 같은 문장", async () => {
    const d = sampleDetail();
    await saveDetail(env.DB, "1", S, d, NOW);
    await saveDetail(env.DB, "1", S, d, NOW + 7 * DAY);
    expect((await adaptive("1"))?.w).toBe(2);
    await saveDetail(env.DB, "1", S, d, NOW + 14 * DAY, { weekly: true });
    expect(await adaptive("1")).toMatchObject({ w: 1, dueAfter: NOW + 14 * DAY });
    await saveDetails(env.DB, [{ id: "1", summary: S, detail: d }, { id: "2", summary: S, detail: d }], NOW + 21 * DAY);
    expect(await adaptive("1")).toMatchObject({ w: 2, dueAfter: NOW + 21 * DAY + WEEK_MS });
    expect(await adaptive("2")).toMatchObject({ w: 1, dueAfter: NOW + 21 * DAY });
  });
});
