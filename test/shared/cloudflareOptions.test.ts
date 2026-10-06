import { describe, expect, it } from "vitest";
import { cloudflareOptions } from "../../scripts/cloudflareOptions.mjs";

describe("R52: vite.config.ts가 @cloudflare/vite-plugin에 넘기는 옵션", () => {
  it("R52: dev 서버(serve)에만 Worker 변수 READ_ONLY=1을 더한다", () => {
    expect(cloudflareOptions({ command: "serve", isPreview: false })).toEqual({ config: { vars: { READ_ONLY: "1" } } });
  });

  it("R52: 빌드(build)에는 READ_ONLY도 vars도 넣지 않는다 — 빌드 결과·운영에 이 값이 없다", () => {
    const options = cloudflareOptions({ command: "build", isPreview: false });
    expect(options).toEqual({});
    expect(JSON.stringify(options)).not.toContain("READ_ONLY");
  });

  it("R52: vite preview는 원격 바인딩을 끄고(운영 D1에 붙지 않는다) READ_ONLY도 넣지 않는다", () => {
    const options = cloudflareOptions({ command: "serve", isPreview: true });
    expect(options).toEqual({ remoteBindings: false });
    expect(JSON.stringify(options)).not.toContain("READ_ONLY");
  });

  it("R52: isPreview가 없는 환경(이전 Vite)에서도 serve는 dev 서버로 본다", () => {
    expect(cloudflareOptions({ command: "serve" })).toEqual({ config: { vars: { READ_ONLY: "1" } } });
  });
});
