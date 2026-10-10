import { describe, expect, it } from "vitest";

// 원문 (Vite가 테스트 빌드 시점에 묶어 준다)
const raw = (files: Record<string, unknown>) => Object.values(files)[0] as string;
const wrangler = raw(import.meta.glob("../../wrangler.jsonc", { query: "?raw", import: "default", eager: true }));
const types = raw(import.meta.glob("../../worker-configuration.d.ts", { query: "?raw", import: "default", eager: true }));

describe("infra: 생성된 Worker 타입 (worker-configuration.d.ts)", () => {
  it("infra: Env의 vars 타입이 wrangler.jsonc vars 값과 같다 — wrangler.jsonc나 Worker 내보내기를 바꾸면 npm run cf-typegen", () => {
    const vars = /"vars"\s*:\s*\{([\s\S]*?)\}/.exec(wrangler)?.[1] ?? "";
    const pairs = [...vars.replace(/\/\/.*$/gm, "").matchAll(/"([A-Z0-9_]+)"\s*:\s*"([^"]*)"/g)].map(([, k, v]) => [k, v]);
    expect(pairs.length).toBeGreaterThan(3);
    const env = /interface __BaseEnv_Env \{([\s\S]*?)\n\}/.exec(types)?.[1] ?? "";
    const typed = Object.fromEntries([...env.matchAll(/^\s*([A-Z0-9_]+): "([^"]*)";$/gm)].map(([, k, v]) => [k, v]));
    expect(typed).toEqual(Object.fromEntries(pairs));
  });
});
