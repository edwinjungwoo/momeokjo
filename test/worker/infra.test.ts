import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../worker/app";

describe("infra", () => {
  it("infra: D1 마이그레이션이 적용되어 있다", async () => {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
    const names = r.results.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["places", "tile_places", "tiles"]));
    expect(names).not.toContain("place_details");
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

  it("infra: 처리하지 못한 오류는 스택 없이 JSON {error: \"internal\"} 500으로 답하고 console.error에 남긴다", async () => {
    const boom = new Error("secret detail at worker/repo.ts:42");
    const brokenDb = {
      prepare: () => {
        throw boom;
      },
      batch: async () => {
        throw boom;
      },
    } as unknown as D1Database;
    const app = createApp({ fetcher: async () => new Response(""), rateLimit: async () => true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request("http://localhost/api/places?hub=bongeunsa&radius=1000"), { ...env, DB: brokenDb }, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "internal" });
      expect(text).not.toContain("secret");
      expect(err.mock.calls.some((c) => c.includes(boom))).toBe(true);
    } finally {
      err.mockRestore();
    }
  });
});
