# 운영 배포 (mmj.itmz.me)

운영 배포는 `npm run release` 하나로 해요. 스크립트(`scripts/deploy.mjs`, 판단은 `scripts/release.mjs`)는 아래 단계를 순서대로 밟고, **처음 실패한 곳에서 멈춰요.** 마이그레이션이 실패하면 배포하지 않고, 배포 뒤 스모크가 실패하면 직전 버전으로 자동 롤백해요.

왜 만들었나:
- 2026-10-05: 원격 마이그레이션이 D1 일일 한도로 실패했는데 배포는 나가서 롤백해야 했어요.
- 2026-10-06: 09:04 예약 배포가 돌지 않아 운영자가 손으로 런북을 따라 했어요.

## 준비

- `feat/mvp` 또는 `main` 브랜치, 작업 트리가 깨끗하고(`docs/deploys.md`와 `.claude/`는 빼고 봐요) HEAD가 `origin/<브랜치>`와 같아야 해요.
- `npx wrangler login` (또는 `CLOUDFLARE_API_TOKEN`)으로 운영 계정에 로그인되어 있어야 해요.
- `.env.local`에 `VITE_KAKAO_JS_KEY` (빌드에 들어가는 공개 지도 키).
- `ADMIN_TOKEN`: 환경 변수나 `.dev.vars`에 있으면 써요. 값은 출력하지 않고 백필·스모크에 환경 변수로만 넘겨요. 후속 작업(백필)이 필요한 마이그레이션을 적용할 때는 꼭 있어야 해요.
- `curl`, `jq` (스모크).

## 쓰는 법

```sh
npm run release -- --dry-run   # 먼저: 확인만 하고 계획을 보여줘요 (운영은 안 바꿔요)
npm run release                # 계획을 보여주고 터미널에서 y를 받은 뒤 진행
npm run release -- --yes       # 묻지 않고 진행 (터미널이 아니면 --yes가 있어야 진행해요)
```

| 플래그 | 뜻 |
|---|---|
| `--dry-run` | 로컬 확인 + 운영 **읽기**만 (비밀값 이름, `SELECT 1`, 마이그레이션 목록, 적용 전 확인, 활성 버전). 적용·배포·후속 작업·스모크·롤백·기록은 하지 않아요 |
| `--yes` (`-y`) | 확인 질문 없이 진행 |
| `--allow-destructive` | `DROP`·`RENAME`·`ALTER … DROP`·`DELETE FROM`이 든 마이그레이션도 적용 (기본은 거절) |
| `--skip-tests --force` | typecheck·test를 건너뛰어요 (빌드는 해요). `--force` 없이는 거절 |

종료 코드: `0` 성공 · `1` 배포 전에 멈춤(운영 코드는 그대로) · `2` 스모크 실패 → 자동 롤백함 · `3` 사람이 확인해야 함(롤백 실패, 스모크 결과를 못 읽음, 후속 작업 실패, 배포 결과 불명).

## 스크립트가 하는 일

1. **사전 확인 (로컬)** — 브랜치, 깨끗한 트리, `git fetch` 뒤 HEAD = `origin/<브랜치>`, `curl`·`jq`, `npm run typecheck`, `npm test`, `npm run build`, `dist/client/index.html`에 `%VITE_` 자리표시자 없음, `wrangler secret list`에 `KAKAO_REST_KEY`·`ADMIN_TOKEN` 이름 있음 (값은 보지 않아요).
2. **D1 접근** — `wrangler d1 execute momeokjo --remote --command "SELECT 1"`. 오류 7500(일일 한도)이면 "한도 리셋(09:00 KST) 뒤 다시"로 멈춰요.
3. **마이그레이션** — `wrangler d1 migrations list momeokjo --remote`로 남은 것을 읽어요. 없으면 건너뛰어요. 있으면:
   - SQL에 되돌릴 수 없는 문장이 있으면 거절 (`--allow-destructive`로만 허용).
   - `scripts/migrationChecks.mjs`에 등록된 객체가 **적용 전에 이미 있으면** 멈춰요 (일부만 적용된 상태 — 손으로 맞춰요. 예: 0003이 남았는데 `meta` 테이블이 있음).
   - 계획을 보여주고 확인을 받은 뒤 `wrangler d1 migrations apply momeokjo --remote`.
   - 다시 목록을 읽어 **남은 것이 없어야** 하고, 등록된 사후 확인(0003 → `meta`·`idx_places_status_fetched_at`, 0004 → `events`·인덱스 2개, 0005 → `places.list_json` 열)이 **모두 있어야** 해요. 하나라도 틀리면 배포 전에 멈춰요.
4. **롤백 대상 기록** — `wrangler deployments list --json`에서 가장 최근 배포의 100% 버전. 트래픽이 나뉘어 있으면(점진 배포 중) 멈춰요.
5. **배포** — `npm run deploy` (vite build && wrangler deploy). 출력의 `Current Version ID:`로 새 버전을 읽어요(없으면 deployments list로 확인). 배포 명령이 실패하면 활성 버전을 다시 보고, 그대로면 "반영 안 됨"(1), 바뀌었으면 확인 필요(3).
6. **후속 작업** — 이번에 **적용한** 마이그레이션에 등록된 것만. 0005 → 거점마다 `node scripts/backfill.mjs --hub <id> --limit 150`. 백필이 D1 예산·요청 제한으로 멈추면(종료 코드 2) 경고만 해요(남은 행은 Cron이 채워요). 다른 실패는 스모크까지 마친 뒤 종료 코드 3.
7. **스모크** — 10초 기다린 뒤 `B=https://mmj.itmz.me scripts/smoke.sh` (요청 25번 안팎, ADMIN_TOKEN이 있으면 거점별 감사 Q1·Q2 포함). **FAIL > 0이면** 4에서 기록한 버전으로 `wrangler rollback <id> --message "release: 스모크 FAIL n 자동 롤백 (<커밋>)" --yes`. 요약 줄을 못 읽으면 운영을 함부로 되돌리지 않고 확인 필요(3)로 끝내요.
8. **요약·기록** — 버전(이전 → 새), 적용한 마이그레이션, 후속 작업 결과, 스모크 결과, 롤백 대상, 걸린 시간. 운영을 바꿨으면(마이그레이션 적용이나 배포를 시도했으면) `docs/deploys.md`에 한 줄을 더해요.

### 배포 기록(`docs/deploys.md`)은 커밋하지 않아요

스크립트는 줄만 더하고 커밋·푸시하지 않아요. 배포하는 커밋(HEAD = origin)을 스크립트가 바꾸지 않게 하려는 거예요. 대신 작업 트리 확인에서 `docs/deploys.md`는 빼고 보니, 기록을 커밋하지 않은 채로 다음 배포를 해도 돼요. 운영자가 적당한 때에:

```sh
git add docs/deploys.md && git commit -m "docs(deploy): <날짜> 배포 기록" && git push
```

## 마이그레이션 규칙

- **더하기만 해요** (`CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE … ADD COLUMN`). 롤백은 Worker 코드만 되돌리고 D1은 그대로라서, 이전 버전도 새 스키마에서 돌아야 해요. `DROP`·`RENAME`·`ALTER … DROP`·`DELETE FROM`은 스크립트가 거절해요.
- 새 마이그레이션을 더하면 `scripts/migrationChecks.mjs`에 항목을 더해요:
  ```js
  "0006_rollups.sql": {
    checks: [{ what: "daily_rollups 테이블", sql: "SELECT name FROM sqlite_master WHERE name IN ('daily_rollups')", expect: ["daily_rollups"] }],
    // 배포 뒤 한 번 돌릴 것이 있으면 (이번에 적용했을 때만 돌아요)
    // hooks: [{ name: "…", needsAdminToken: true, commands: (hubIds) => [{ cmd: "node", args: ["scripts/….mjs"] }] }],
  },
  ```
  `sql`은 결과에 `name` 열이 있는 읽기 쿼리(`sqlite_master`, `PRAGMA table_info(<표>)`)예요. 등록하지 않아도 배포는 되지만 "남은 마이그레이션 없음"만 확인해요.

## 롤백과 한계

- 자동 롤백 대상은 **이번 배포 직전에 운영 중이던 버전**이에요. 같은 D1 스키마(마이그레이션 적용 전)에서 돌던 버전이고, 마이그레이션은 더하기만 하니 새 스키마에서도 돌아요.
- **마이그레이션은 되돌리지 않아요.** 되돌릴 방법도 없어요 — 그래서 더하기만.
- **`wrangler rollback`은 Cron 트리거를 되돌리지 않아요.** 롤백 뒤에도 지금 `wrangler.jsonc`의 `crons`가 남아요. 이전 버전이 다른 주기를 기대하면 손으로 맞춰야 해요 (예: `2f5adde0`은 `*/10`을 기대해요 — 대시보드의 Triggers나 그 커밋의 설정으로 `wrangler triggers deploy`).
- 손으로 다른 버전으로 롤백할 때는 아래 표를 봐요. 0005(`list_json`) 뒤에는 `v1:` 조각을 쓰는 행이 있어서, 그 형식을 모르는 중간 버전은 목록 JSON을 망가뜨려요.

| 버전 | 커밋 | 롤백해도 되나 | 메모 |
|---|---|---|---|
| `72a9f970` | `3a4cc93` | 네 | 2026-10-06 09:24 배포, 0003~0005 뒤, Cron `*/5` |
| `2f5adde0` | 0005 이전 | 네 (문서로 확인한 안전 대상) | `v1:` 조각을 견뎌요. Cron을 `*/10`으로 같이 바꿔야 해요 |
| `cd11d71`(Task 28) ~ `8fce5cd` 사이 커밋으로 만든 버전 | — | **아니요** | 옛 읽기 코드가 `v1:` 조각에서 틀린 JSON을 내요 |

롤백 명령: `npx wrangler rollback <버전 id> --message "<이유>"` (스크립트 밖에서는 확인 질문이 나와요).

## D1 일일 한도

- 무료 플랜의 D1 읽기·쓰기 한도는 **매일 00:00 UTC = 09:00 KST**에 풀려요. 한도를 넘으면 쿼리가 오류 7500으로 실패해요. 스크립트는 처음 `SELECT 1`에서 이걸 알아보고 아무것도 바꾸지 않은 채 멈춰요.
- 스크립트 자체가 쓰는 읽기는 몇 행뿐이에요(`SELECT 1`, 마이그레이션 목록, `sqlite_master`·`PRAGMA` 확인). 백필은 행을 많이 읽고 써요(0005 때 동대문 약 2천 행).
- 개발 서버도 운영 D1에 붙어 있어서(읽기 전용이어도) 읽기 한도를 같이 써요. 배포 날 아침에는 개발 서버를 꺼 두는 편이 좋아요.

## 스크립트 밖에서 하는 확인

스크립트는 스모크까지만 해요. 런북의 나머지 관문은 사람이 봐요:
- 엣지 캐시: 30초 안에 같은 목록을 세 번 — 2·3번째가 훨씬 빨라야 해요 (`curl -s -o /dev/null -w '%{time_starttransfer}\n' 'https://mmj.itmz.me/api/places?hub=bongeunsa&radius=1000'`).
- CPU: `npx wrangler tail momeokjo --format json`을 켜고 60초 뒤 `hub=ddp&radius=1000` — outcome이 ok이고 exceededCpu가 아니어야 해요.
- 10분쯤 뒤 tail에서 Cron이 `skipped` 없이 돌고 `tiles.incomplete`가 0.
- 실제 브라우저(375×812): 지도, 핀·칩, WebP 사진, 공유, `/pangyo`, `/admin`.

## 손으로 배포하기 (스크립트를 못 쓸 때)

스크립트가 하는 것과 같은 순서예요. 하나라도 실패하면 다음으로 가지 않아요.

```sh
git status                       # 깨끗한지, feat/mvp(또는 main)인지
npm run typecheck && npm test && npm run build
! grep -q '%VITE_' dist/client/index.html
npx wrangler secret list         # KAKAO_REST_KEY, ADMIN_TOKEN 이름만 확인
npx wrangler d1 execute momeokjo --remote --command "SELECT 1"     # 7500이면 09:00 KST 뒤에
npx wrangler d1 migrations list momeokjo --remote
npx wrangler d1 execute momeokjo --remote --command "SELECT type,name FROM sqlite_master WHERE name IN ('meta','events','idx_places_status_fetched_at','idx_events_day','idx_events_type_day')"
#   남은 마이그레이션의 객체가 이미 있으면 멈추고 손으로 맞춰요
npx wrangler d1 migrations apply momeokjo --remote   # 완전히 성공해야 해요. 다시 list → 남은 것 없음, 위 확인 쿼리·PRAGMA table_info(places)
npx wrangler deployments list    # 지금 100% 버전 id를 적어 둬요 (롤백 대상)
npm run deploy                   # 새 Current Version ID를 적어 둬요
ADMIN_TOKEN=… npm run backfill -- --hub ddp --limit 150      # 0005를 이번에 적용했으면 거점마다
B=https://mmj.itmz.me scripts/smoke.sh                       # FAIL 0이어야. 아니면 npx wrangler rollback <적어 둔 id>
```

토큰은 `read -rs ADMIN_TOKEN && export ADMIN_TOKEN`으로 화면에 남기지 않고 넣어요. 운영자 런북 원본은 `.superpowers/sdd/deploy-runbook.md`(로컬, 저장소에는 없음)에 있어요.

## CI (GitHub Actions)

`.github/workflows/ci.yml`: 모든 푸시와 PR에서 Node 26, `npm ci`(npm 캐시), `npm run typecheck`, `npm test`, `npm run build`, `%VITE_` 자리표시자 확인.
- Cloudflare 자격 증명이 필요 없어요. 테스트는 `vitest.config.ts`의 `remoteBindings: false`로 로컬 D1을 쓰고, 빌드는 원격 D1에 붙지 않아요 (잘못된 `CLOUDFLARE_API_TOKEN`으로 빌드·테스트가 통과하는 것을 확인했어요).
- 빌드용 `VITE_KAKAO_JS_KEY`는 가짜 값이에요 (CI 빌드 결과는 배포하지 않아요).

### CI에서 배포하기 (나중에, 지금은 꺼 둠)

켜려면 저장소 비밀값에 `CLOUDFLARE_API_TOKEN`(Workers·D1 편집 권한), `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_TOKEN`, `VITE_KAKAO_JS_KEY`를 넣고, 수동 실행 잡을 따로 둬요. 예:

```yaml
# .github/workflows/release.yml (예시 — 아직 만들지 않음)
on: workflow_dispatch
jobs:
  release:
    runs-on: ubuntu-latest
    environment: production   # 승인자를 두려면
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v5
        with: { node-version: 26, cache: npm }
      - run: npm ci
      - run: sudo apt-get install -y jq
      - run: npm run release -- --yes
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          ADMIN_TOKEN: ${{ secrets.ADMIN_TOKEN }}
          VITE_KAKAO_JS_KEY: ${{ secrets.VITE_KAKAO_JS_KEY }}
```

켜기 전에 확인할 것: 러너에서 브랜치 확인(`git rev-parse --abbrev-ref HEAD`)과 origin 비교가 맞게 도는지(태그·PR 체크아웃은 분리된 HEAD라 거절돼요 — feat/mvp·main에서만 실행), `docs/deploys.md` 기록은 러너와 함께 사라지니 아티팩트로 올리거나 커밋하는 단계를 더할지.
