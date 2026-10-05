import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";

type FetchApp = { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> };

/** 앱을 호출하고 waitUntil 작업까지 모두 끝날 때까지 기다린다 */
export async function callApp(app: FetchApp, path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(`http://localhost${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
