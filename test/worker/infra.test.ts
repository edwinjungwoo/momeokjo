import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("infra", () => {
  it("infra: D1 마이그레이션이 적용되어 있다", async () => {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
    const names = r.results.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["place_details", "places", "tiles"]));
  });

  it("infra: 테스트 사이에 데이터가 격리된다 (1)", async () => {
    await env.DB.prepare("INSERT INTO tiles (key, collected_at, place_count) VALUES ('a', 1, 0)").run();
    const r = await env.DB.prepare("SELECT count(*) AS c FROM tiles").first<{ c: number }>();
    expect(r?.c).toBe(1);
  });

  it("infra: 테스트 사이에 데이터가 격리된다 (2)", async () => {
    const r = await env.DB.prepare("SELECT count(*) AS c FROM tiles").first<{ c: number }>();
    expect(r?.c).toBe(0);
  });

  it("infra: /api/health가 ok를 반환한다", async () => {
    const res = await exports.default.fetch("http://localhost/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
