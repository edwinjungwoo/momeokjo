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

  // 둘 다 한 행을 넣고 자기 행만 보이는지 본다 — 어느 쪽이 먼저 돌든(순서·-t로 하나만 돌려도) 격리가 깨지면 나중 것이 두 행을 본다
  const keysAfterInsert = async (key: string) => {
    await env.DB.prepare("INSERT INTO tiles (key, collected_at, place_count) VALUES (?, 1, 0)").bind(key).run();
    return (await env.DB.prepare("SELECT key FROM tiles").all<{ key: string }>()).results.map((r) => r.key);
  };

  it("infra: 테스트 사이에 데이터가 격리된다 (1)", async () => {
    expect(await keysAfterInsert("a")).toEqual(["a"]);
  });

  it("infra: 테스트 사이에 데이터가 격리된다 (2)", async () => {
    expect(await keysAfterInsert("b")).toEqual(["b"]);
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
