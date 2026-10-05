declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}

/** Vite 변환으로 테스트에서 쓰는 것들 (worker tsconfig에는 vite/client 타입이 없다) */
declare module "*?raw" {
  const content: string;
  export default content;
}
interface ImportMeta {
  glob(pattern: string, options?: { query?: string; import?: string; eager?: boolean }): Record<string, unknown>;
}
