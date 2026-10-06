import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

/**
 * R52: 개발 서버(vite dev)도 wrangler.jsonc의 `"remote": true` 때문에 운영 D1에 붙는다. 그래서 dev 서버에서만
 * READ_ONLY=1을 Worker 변수에 더해 운영 D1을 읽기만 하게 한다 (worker/readOnly.ts).
 * `vite build`에는 넣지 않으므로 빌드 결과(dist/momeokjo/wrangler.json)와 운영 배포에는 이 값이 없다.
 */
const DEV_ONLY_VARS = { READ_ONLY: "1" };

export default defineConfig(({ command }) => ({
  plugins: [react(), cloudflare(command === "serve" ? { config: { vars: DEV_ONLY_VARS } } : {})],
}));
