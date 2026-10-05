import { describe, expect, it } from "vitest";

// 화면 코드 원문 (Vite가 빌드 시점에 묶어 준다 — 테스트 런타임에 파일 시스템이 없어도 된다)
const sources = {
  ...import.meta.glob("../../web/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../shared/**/*.ts", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

/** 값으로 불러오는 모듈만 (import type, 이름이 전부 type인 import는 빌드에서 지워진다). 동적 import()도 따라간다 */
function valueImports(code: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gms;
  for (const m of code.matchAll(re)) {
    if (m[2]) continue;
    const named = /^\{([^}]*)\}$/.exec(m[3].trim());
    const allTypes =
      named !== null &&
      named[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "));
    if (!allTypes) out.push(m[4]);
  }
  for (const m of code.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push(m[1]);
  for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

function resolve(from: string, spec: string): string | null {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const base = parts.join("/");
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => p in sources) ?? null;
}

/** web/main.tsx에서 닿는 모든 모듈과, 그 모듈들이 부르는 패키지 */
function clientGraph() {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const todo = ["../../web/main.tsx"];
  while (todo.length > 0) {
    const file = todo.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of valueImports(sources[file])) {
      if (!spec.startsWith(".")) {
        packages.add(spec);
        continue;
      }
      const next = resolve(file, spec);
      if (next) todo.push(next);
    }
  }
  return { modules: seen, packages };
}

describe("client bundle", () => {
  it("R45: 화면 번들(web/main.tsx에서 닿는 모듈)은 zod를 불러오지 않는다 (gzip 약 22KB)", () => {
    const { modules, packages } = clientGraph();
    expect(modules.has("../../web/App.tsx")).toBe(true);
    expect(modules.has("../../shared/settings.ts")).toBe(true);
    expect([...packages].filter((p) => p === "zod" || p.startsWith("zod/"))).toEqual([]);
  });

  it("R45: import type은 값 import로 치지 않는다 (가드 자체 확인)", () => {
    expect(valueImports(`import type { A } from "zod";\nimport { type B, type C } from "zod";`)).toEqual([]);
    expect(valueImports(`import { z } from "zod";\nimport { type B, c } from "./x";`)).toEqual(["zod", "./x"]);
    expect(valueImports(`const P = lazy(() => import("./admin/AdminPage"));`)).toEqual(["./admin/AdminPage"]);
  });
});
