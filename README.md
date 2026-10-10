# 모먹죠 (mmj.itmz.me)

거점(역) 근처 점심 추천 — 공개 거점 14곳(봉은사역·삼성역·강남역·판교역·여의도역·광화문역 등, 목록은 `shared/hubs.ts`). Cloudflare Worker 하나(Hono API + React SPA, `@cloudflare/vite-plugin`) + D1 + Cron 트리거 둘(본 Cron `*/5` 수집·보충·집계, 둘째 `* * * * *` 스냅샷·상세만 보충). 설계는 `docs/superpowers/specs/2026-10-05-momeokjo-design.md`, 배포는 `docs/deploy.md`.

## 개발

```sh
npm install
npm run dev        # vite dev, http://localhost:5173
npm test           # Vitest + workerd, 격리된 로컬 D1 (운영 D1에 붙지 않는다)
npm run typecheck
npm run build      # dist/
npm run release    # 운영 배포 — 마이그레이션 적용·확인 → 기준 스모크 → 배포 → 스모크 → 회귀면 자동 롤백 (docs/deploy.md)
```

배포는 언제나 `npm run release`로 해요. `npm run deploy`(`vite build && wrangler deploy`)만 돌리면 마이그레이션·스모크·롤백을 건너뛰어요(2026-10-05 사고 뒤에 만든 안전장치).

비밀값은 git에 없다: `KAKAO_REST_KEY`·`ADMIN_TOKEN`은 `.dev.vars`, `VITE_KAKAO_JS_KEY`는 `.env.local`.

### 개발 서버는 운영 D1을 읽기만 해요 (R52)

`wrangler.jsonc`의 D1 바인딩이 `"remote": true`라서 `npm run dev`도 **운영 D1**에 붙어요. 그래서 `vite.config.ts`가 dev 서버에서만 Worker 변수 `READ_ONLY=1`을 넣고(`wrangler.jsonc`·`.dev.vars`에는 없고, `vite build` 결과와 운영에도 없어요), Worker는 그때:

- D1을 `readOnlyDb`(`worker/readOnly.ts`)로 감싸 INSERT·UPDATE·DELETE·REPLACE·CREATE·DROP·ALTER·쓰기 PRAGMA·VACUUM 등을 실행 전에 막고, `exec`는 항상 막아요. `READ_ONLY`는 비어 있지 않고 `0`·`false`가 아니면 켜져요.
- 켜져 있으면 첫 요청에서 `[read-only] 운영 D1 읽기 전용 모드`를 로그에 한 번 남겨요.
- 목록·단건·통계 읽기와 응답 캐시는 그대로예요. 만료된 격자 수집, 상세 보충·저장, 요청별 D1 사용량 기록은 하지 않아요.
- `/api/events`는 아무것도 저장하지 않고 204, `/api/admin/warm`·`/api/admin/backfill`은 403 `{"error":"read_only"}`, Cron은 로그 한 줄만 남겨요.

dev 서버가 읽은 행도 운영 계정의 **하루 D1 읽기 한도(5,000,000행)에 그대로 들어가요** (R38 사용량 집계에는 잡히지 않아요). 큰 거점 목록 한 번이 수천 행이니 dev 서버에서 새로고침을 반복하지 마세요. 쓰기가 필요한 작업(warm·backfill)은 운영 주소에 `npm run warm`·`npm run backfill`로 해요.

주의:

- **`wrangler dev`는 쓰지 마세요.** `vite.config.ts`를 거치지 않아 읽기 전용 모드가 없고, `"remote": true` 때문에 운영 D1에 읽기·쓰기로 붙어요. 꼭 필요하면 `wrangler dev --local`로만 실행하고, 개발은 `npm run dev`로 해요.
- `vite preview`는 원격 바인딩을 꺼서(`remoteBindings: false`) 운영 D1에 붙지 않아요. 비어 있는 로컬 D1을 써요.
