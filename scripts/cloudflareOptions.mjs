/**
 * R52: vite.config.ts가 @cloudflare/vite-plugin에 넘기는 옵션 (설정 파일에서 빼 단위 테스트한다).
 * - dev 서버(`vite`): Worker 변수 READ_ONLY=1 — 운영 D1을 읽기만 한다 (worker/readOnly.ts).
 * - `vite build`: 아무것도 더하지 않는다 — 빌드 결과(dist/momeokjo/wrangler.json)와 운영에는 READ_ONLY가 없다.
 * - `vite preview`: 원격 바인딩을 끈다 — 빌드 결과 설정을 쓰므로 READ_ONLY가 없고, 그대로면 운영 D1(`"remote": true`)에 쓰기까지 붙는다.
 *   (플러그인은 preview 분기보다 먼저 remoteBindings를 읽는다.) 미리보기는 비어 있는 로컬 D1을 쓴다.
 * `vite preview`의 command도 "serve"이므로 isPreview를 먼저 본다.
 */
export function cloudflareOptions({ command, isPreview }) {
  if (isPreview) return { remoteBindings: false };
  return command === "serve" ? { config: { vars: { READ_ONLY: "1" } } } : {};
}
