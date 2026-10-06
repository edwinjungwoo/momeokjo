# 모먹죠 (mmj.itmz.me)

ASEM 타워 근처 점심 추천. Cloudflare Worker 하나(Hono API + React SPA, `@cloudflare/vite-plugin`) + D1 + Cron(5분). 설계는 `docs/superpowers/specs/2026-10-05-momeokjo-design.md`.

## 개발

```sh
npm install
npm run dev        # vite dev, http://localhost:5173
npm test           # Vitest + workerd, 격리된 로컬 D1 (운영 D1에 붙지 않는다)
npm run typecheck
npm run build      # dist/ (배포는 npm run deploy)
```

비밀값은 git에 없다: `KAKAO_REST_KEY`·`ADMIN_TOKEN`은 `.dev.vars`, `VITE_KAKAO_JS_KEY`는 `.env.local`.

### 개발 서버는 운영 D1을 읽기만 해요 (R52)

`wrangler.jsonc`의 D1 바인딩이 `"remote": true`라서 `npm run dev`도 **운영 D1**에 붙어요. 그래서 `vite.config.ts`가 dev 서버에서만 Worker 변수 `READ_ONLY=1`을 넣고(`wrangler.jsonc`·`.dev.vars`에는 없고, `vite build` 결과와 운영에도 없어요), Worker는 그때:

- D1을 `readOnlyDb`(`worker/readOnly.ts`)로 감싸 INSERT·UPDATE·DELETE·REPLACE·CREATE·DROP·ALTER·쓰기 PRAGMA·VACUUM 등을 실행 전에 막아요.
- 목록·단건·통계 읽기와 응답 캐시는 그대로예요. 만료된 격자 수집, 상세 보충·저장, 요청별 D1 사용량 기록은 하지 않아요.
- `/api/events`는 아무것도 저장하지 않고 204, `/api/admin/warm`·`/api/admin/backfill`은 403 `{"error":"read_only"}`, Cron은 로그 한 줄만 남겨요.

dev 서버가 읽은 행도 운영 계정의 **하루 D1 읽기 한도(5,000,000행)에 그대로 들어가요** (R38 사용량 집계에는 잡히지 않아요). 큰 거점 목록 한 번이 수천 행이니 dev 서버에서 새로고침을 반복하지 마세요. 쓰기가 필요한 작업(warm·backfill)은 운영 주소에 `npm run warm`·`npm run backfill`로 해요.
