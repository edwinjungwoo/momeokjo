import { createApp } from "./app";
import type { FetchFn } from "./fetchFn";
import { runScheduled } from "./maintenance";

const realFetch: FetchFn = (input, init) => fetch(input, init);
const app = createApp({ fetcher: realFetch });

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
