import { createApp } from "./app";
import type { FetchFn } from "./fetchFn";

const realFetch: FetchFn = (input, init) => fetch(input, init);
const app = createApp({ fetcher: realFetch });

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
