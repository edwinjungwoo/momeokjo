import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { cloudflareOptions } from "./scripts/cloudflareOptions.mjs";

/**
 * R52: 개발 서버(vite dev)도 wrangler.jsonc의 `"remote": true` 때문에 운영 D1에 붙는다. 그래서 dev 서버에서만
 * READ_ONLY=1을 Worker 변수에 더해 운영 D1을 읽기만 하게 한다 (worker/readOnly.ts). 옵션은 scripts/cloudflareOptions.mjs.
 * `vite build`에는 넣지 않으므로 빌드 결과(dist/momeokjo/wrangler.json)와 운영 배포에는 이 값이 없고,
 * `vite preview`는 원격 바인딩을 꺼서 운영 D1에 붙지 않는다.
 */
export default defineConfig(({ command, isPreview }) => ({
  plugins: [react(), cloudflare(cloudflareOptions({ command, isPreview }))],
  // 서브에이전트 작업 트리(.claude/worktrees)와 작업 기록(.superpowers)이 바뀔 때 dev 서버가 다시 읽지 않게
  server: { watch: { ignored: ["**/.claude/**", "**/.superpowers/**"] } },
}));
