import { createApp } from "./app";
import type { FetchFn } from "./fetchFn";
import { runCron } from "./maintenance";
import { isReadOnly, logReadOnlyOnce, readOnlyEnv } from "./readOnly";

const realFetch: FetchFn = (input, init) => fetch(input, init);
// 커스텀 도메인에서만 동작한다 (workers.dev에서는 캐시가 비어 있어 매번 새로 만든다)
const app = createApp({ fetcher: realFetch, cache: caches.default });

export default {
  // R52: 개발 서버(READ_ONLY=1, vite.config.ts)는 운영 D1을 읽기만 한다 — 빠뜨린 쓰기는 readOnlyDb가 실행 전에 막는다
  fetch(request, env, ctx) {
    logReadOnlyOnce(env);
    return app.fetch(request, readOnlyEnv(env), ctx);
  },
  // R56: controller.cron으로 본 Cron(수집·보충)과 스냅샷 Cron을 나눈다 (worker/maintenance.ts runCron).
  // R52: 읽기 전용 개발 모드면 두 Cron 모두 아무것도 하지 않는다
  async scheduled(controller, env, ctx) {
    if (isReadOnly(env)) {
      console.log("cron skipped: READ_ONLY=1 (dev server, production D1 is read-only)");
      return;
    }
    ctx.waitUntil(
      runCron(controller.cron, env, { fetcher: realFetch, now: Date.now() })
        .then((r) => console.log(`cron ${r.cron}`, JSON.stringify(r.result)))
        .catch((e) => console.error("cron failed", controller.cron, e)),
    );
  },
} satisfies ExportedHandler<Env>;
