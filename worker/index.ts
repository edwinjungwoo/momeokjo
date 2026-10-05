import { createApp } from "./app";
import type { FetchFn } from "./fetchFn";
import { runScheduled } from "./maintenance";

const realFetch: FetchFn = (input, init) => fetch(input, init);
// 커스텀 도메인에서만 동작한다 (workers.dev에서는 캐시가 비어 있어 매번 새로 만든다)
const app = createApp({ fetcher: realFetch, cache: caches.default });

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runScheduled(env, { fetcher: realFetch, now: Date.now() })
        .then((r) => console.log("cron warm", JSON.stringify(r)))
        .catch((e) => console.error("cron warm failed", e)),
    );
  },
} satisfies ExportedHandler<Env>;
