import { createApp } from "./app";
import type { FetchFn } from "./fetchFn";
import { runCron } from "./maintenance";

const realFetch: FetchFn = (input, init) => fetch(input, init);
// 커스텀 도메인에서만 동작한다 (workers.dev에서는 캐시가 비어 있어 매번 새로 만든다)
const app = createApp({ fetcher: realFetch, cache: caches.default });

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  // R56: controller.cron으로 본 Cron(수집·보충)과 스냅샷 Cron을 나눈다 (worker/maintenance.ts runCron).
  // 읽기 전용 개발 모드(feat/mvp R52)의 이른 return은 이 함수 맨 앞에 그대로 둔다 — 두 Cron 모두 아무것도 하지 않는다
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runCron(controller.cron, env, { fetcher: realFetch, now: Date.now() })
        .then((r) => console.log(`cron ${r.cron}`, JSON.stringify(r.result)))
        .catch((e) => console.error("cron failed", controller.cron, e)),
    );
  },
} satisfies ExportedHandler<Env>;
