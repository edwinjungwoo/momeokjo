import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // 테스트는 절대 운영 D1에 붙지 않는다
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            KAKAO_REST_KEY: "test-rest-key",
            ADMIN_TOKEN: "test-admin-token",
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
