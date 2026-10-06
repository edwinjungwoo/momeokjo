import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

type FetchApp = { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> };

/** 앱을 호출하고 waitUntil 작업까지 모두 끝날 때까지 기다린다 (바인딩을 바꿔 부르려면 e를 넘긴다) */
export async function callApp(app: FetchApp, path: string, init?: RequestInit, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://localhost${path}`, init), e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
