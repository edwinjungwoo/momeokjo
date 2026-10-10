# 운영 배포 (mmj.itmz.me)

운영 배포는 `npm run release` 하나로 해요. 스크립트(`scripts/deploy.mjs`, 판단은 `scripts/release.mjs`)는 아래 단계를 순서대로 밟고, **처음 실패한 곳에서 멈춰요.** 마이그레이션이 실패하면 배포하지 않고, 배포 뒤 스모크에 **배포 전에는 없던 코드 수준 FAIL**이 생기면 직전 버전으로 자동 롤백해요.

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
| `--dry-run` | 로컬 확인 + 운영 **읽기**만 (비밀값 이름, `SELECT 1`, 마이그레이션 목록, 적용 전 확인, 활성 버전). 적용·배포·후속 작업·스모크·롤백·기록은 하지 않아요. 단, `wrangler d1 migrations list --remote`는 목록을 읽기 전에 늘 `CREATE TABLE IF NOT EXISTS d1_migrations …`를 보내요 — 표가 이미 있으니 바뀌는 것은 없지만 엄밀히는 쓰기 문장이에요 |
| `--yes` (`-y`) | 확인 질문 없이 진행. 기준 스모크의 FAIL은 **받아들이지 않아요** — 기준이 빨가면 FAIL을 보여주고 배포 전에 멈춰요(1) |
| `--accept-baseline-fails` | 배포 전 기준 스모크에 FAIL이 있어도 진행 — 이 플래그로만 돼요 (그 FAIL은 보여주고, 배포 뒤에는 새로 생긴 FAIL만 봐요) |
| `--allow-destructive` | `DROP`·`RENAME`·`ALTER … DROP`·`DELETE FROM`이 든 마이그레이션도 적용 (기본은 거절) |
| `--skip-tests --force` | typecheck·test를 건너뛰어요 (빌드는 해요). `--force` 없이는 거절 |

종료 코드: `0` 성공 · `1` 배포 전에 멈춤(운영 코드는 그대로) · `2` 새 코드 FAIL → 자동 롤백함(롤백 대상과 Cron 트리거가 같을 때) · `3` 사람이 확인해야 함(데이터 상태 확인 필요, 다시 돌리니 사라진 일시 FAIL, 롤백 실패, 스모크 결과를 못 읽음, 후속 작업 실패, 배포됐는데 버전 불명, 자동 롤백했는데 롤백 대상의 Cron 트리거가 다르거나 비교하지 못함). 배포 명령이 성공한 뒤의 실패는 항상 3이에요.

## 스크립트가 하는 일

1. **사전 확인 (로컬)** — 브랜치, 깨끗한 트리, `git fetch` 뒤 HEAD = `origin/<브랜치>`, `curl`·`jq`, `npm run typecheck`, `npm test`, `npm run build`, `dist/client/index.html`에 `%VITE_` 자리표시자 없음, `wrangler secret list`에 `KAKAO_REST_KEY`·`ADMIN_TOKEN` 이름 있음 (값은 보지 않아요).
2. **D1 접근** — `wrangler d1 execute momeokjo --remote --command "SELECT 1"`. 오류 7500(일일 한도)이면 "한도 리셋(09:00 KST) 뒤 다시"로 멈춰요.
3. **마이그레이션** — `wrangler d1 migrations list momeokjo --remote`로 남은 것을 읽어요. 없으면 건너뛰어요. 있으면:
   - SQL에 되돌릴 수 없는 문장이 있으면 거절 (`--allow-destructive`로만 허용).
   - `scripts/migrationChecks.mjs`에 등록된 객체가 **적용 전에 이미 있으면** 멈춰요 (일부만 적용된 상태 — 손으로 맞춰요. 예: 0003이 남았는데 `meta` 테이블이 있음).
   - 계획을 보여주고 확인을 받은 뒤 `wrangler d1 migrations apply momeokjo --remote`.
   - 다시 목록을 읽어 **남은 것이 없어야** 하고, 등록된 사후 확인(0003 → `meta`·`idx_places_status_fetched_at`, 0004 → `events`·인덱스 2개, 0005 → `places.list_json` 열, 0006 → `daily_stats`·`anon_first_seen`, 0007 → `hub_snapshots`, 0008 → `places.interval_weeks`·`fp`·`due_after` 열과 `idx_places_status_due`)이 **모두 있어야** 해요. 하나라도 틀리면 배포 전에 멈춰요.
4. **롤백 대상 기록** — `wrangler deployments list --json`에서 가장 최근 배포의 100% 버전. 이 읽기는 3의 적용(`migrations apply`) **전에** 해요(Task 56) — 트래픽이 나뉘어 있으면(점진 배포 중) 스키마를 바꾸기 전에 멈춰요(1). 그 버전을 배포한 커밋을 `docs/deploys.md`(버전 칸 → 커밋 칸)에서 찾아 `git show <커밋>:wrangler.jsonc`의 `crons`를 이번 배포(지금 `wrangler.jsonc`)와 비교해 알려요(Task 56) — 같으면 `ok`, 다르면 "자동 롤백하면 트리거를 손으로 되돌려야 해요", 커밋을 못 찾거나 읽지 못하면 "비교하지 못했어요". `--dry-run`도 같이 보여줘요.
5. **기준 스모크** — 배포 전에 지금 운영(이전 코드)으로 `scripts/smoke.sh`를 한 번 돌려요. 배포 뒤 결과와 비교할 기준이에요. 결과를 못 읽으면 배포하지 않아요. FAIL이 있으면 그 줄을 보여주고, 그중 **코드 수준** FAIL이 하나라도 있으면 `--accept-baseline-fails` 없이는 배포 전에 멈춰요(1). `--yes`로 도는 비대화식 실행도 마찬가지예요 — 빨간 기준 위에 배포하려면 사람이 플래그로 정해야 해요. 기준 FAIL이 **모두 데이터 상태 신호**(아래 8)면 경고로만 보여주고 플래그 없이 진행해요.
6. **배포** — 확인 질문·기준 스모크 사이에 작업 트리가 더러워졌거나 HEAD가 바뀌지 않았는지(= origin) 다시 본 뒤 `npm run deploy` (vite build && wrangler deploy). 출력의 `Current Version ID:`로 새 버전을 읽어요(없으면 deployments list로 확인).
   - 배포 명령이 실패하면 활성 버전을 다시 보고, 그대로면 "반영 안 됨"(1), 바뀌었으면 확인 필요(3).
   - **배포 명령이 성공했는데 새 버전을 확인하지 못하면**(버전 줄 없음 + deployments list 실패·트래픽 나뉨·이전과 같음) "배포됨 — 버전 불명, 확인 필요"(3)로 멈추고, 기록해 둔 이전 버전으로 되돌리는 명령을 보여줘요. 기록에도 "배포 전 중단"이 아니라 그렇게 남아요(버전 칸 `?`).
7. **후속 작업** — 이번에 **적용한** 마이그레이션에 등록된 것 + 지난 실행에서 남은 것(아래). 0005 → 거점마다 `node scripts/backfill.mjs --hub <id> --limit 150`. 백필이 D1 예산·요청 제한으로 멈추면(종료 코드 2) 경고만 해요(남은 행은 Cron이 채워요). 다른 실패는 다음 실행이 다시 돌리도록 남기고, 스모크까지 마친 뒤 종료 코드 3.
8. **스모크** — 10초 기다린 뒤 다시 `B=https://mmj.itmz.me scripts/smoke.sh`. FAIL 줄을 기준과 **확인 단위로** 비교해요(`" → "` 뒤의 상태 코드와 빌드마다 바뀌는 `/assets/` 해시는 빼고 봐요 — `ddp 500m → 500`과 `→ 000`은 같은 확인). 단, 분류도 키에 넣어서 같은 확인이라도 **데이터 → 코드로 바뀌면**(예: `감사 ddp → 200 {"pass":…}` → `감사 ddp → 500`) 새 FAIL로 봐요.
   - 기준에 없던 **코드 수준** FAIL이 있으면 바로 롤백하지 않고 **20초 기다렸다 스모크를 한 번 더** 돌려요(일시 FAIL 거르기). 다시 돌려도 남은 새 코드 FAIL(처음 것과 같은 확인 = 교집합)이 있을 때만 → 4에서 기록한 버전으로 `wrangler rollback <id> --message "release: 새 스모크 FAIL n 자동 롤백 (<커밋>)" --yes` (2). `wrangler rollback`은 트리거를 되돌리지 않으므로, 4에서 본 롤백 대상의 `crons`가 이번 배포와 다르면 "Cron 트리거를 <그 crons>(으)로 되돌려야 해요"와 `npx wrangler triggers deploy --triggers "…" --triggers "…"`를 크게 찍고 결과 칸에도 남기고 **3**, 비교하지 못했으면 "Cron 트리거 확인 필요"로 **3**이에요.
     - 다시 돌리니 사라졌으면 롤백하지 않지만 간헐적인 문제일 수 있어 "일시 FAIL — 확인 필요"(3) + 롤백 명령. 처음 본 새 FAIL은 요약(`summary.smoke.firstNewFails`)과 출력에 남아요.
     - 다시 돌린 결과를 못 읽거나, 처음과 다른 새 코드 FAIL만 보이면(흔들림) 롤백하지 않고 확인 필요(3) + 롤백 명령. 결과 칸에 이유(불명·흔들림)가 들어가요.
     - 다시 돌리니 데이터 상태 신호만 남으면 "데이터 상태 확인 필요"(3).
   - 기준에 없던 FAIL이 **데이터 상태 신호뿐**이면 → 롤백하지 않고 "데이터 상태 확인 필요"(3). 상세·격자 채움이나 수집 상태 문제일 수 있어서예요. 데이터 상태 신호는 좁게 봐요:
     - 감사가 **200으로 답했지만** Q1·Q2를 통과하지 못한 줄 (`감사 <거점> → 200 {"pass":{…},…}`, smoke.sh 감사 단계). 감사 요청 자체의 실패(`→ 500`·`→ 000`·`→ 401`, 200인데 JSON 없음)는 코드 수준이에요.
     - `<거점> <반경>m 200인데 0곳` (smoke.sh). 단, **같은 실행에서 모든 공개 거점이 0곳이면** 목록 처리가 망가진 것으로 보고 코드 수준이에요 (R62: 스모크는 공개 거점만 목록을 봐요).
     - 준비 중 거점(R62)의 감사는 FAIL이 아니라 `info` 줄이라 여기에 들어오지 않아요.
   - 배포 전부터 있던 FAIL만 남았으면 성공("기준 FAIL n 그대로").
   - 요약 줄을 못 읽거나 FAIL 줄 수가 요약과 다르면 운영을 함부로 되돌리지 않고 확인 필요(3).
   - 스모크 한 번의 요청은 15번 + 거점마다 1번(지금 14곳) + 토큰이 있으면 감사(공개 거점 한 곳 + 준비 중·공개 예정 거점, R67) ≈ 30번이라, 두 번(새 FAIL이 보이면 세 번) 돌리면 약 60번(~90번)이에요.
   - 스모크 변수(`SMOKE_BASELINE`·`SMOKE_AUDIT_ALL`·`SMOKE_AUDIT_PICK`)는 release가 실행마다 정해서 넘겨요(Task 56) — 셸에 남은 `SMOKE_BASELINE=1`이 배포 뒤 스모크를 너그럽게 만들거나 `SMOKE_AUDIT_ALL=1`이 모든 거점을 감사하지 않게.
   - 처음과 다시 돌린 스모크의 새 FAIL이 **모두 연결 실패(`→ 000`)**면 이 컴퓨터의 네트워크가 끊긴 것일 수 있어 롤백하지 않고 확인 필요(3) + 롤백 명령이에요(Task 56). 서버가 답한 실패(5xx 등)가 한 번이라도 있으면 그대로 롤백해요.
   - R67(2026-10-10): 감사는 거점마다 D1 ~8천~1.6만 행을 읽어서, 준비 중·공개 예정 거점은 모두 보고 이미 공개된 거점은 **한 곳만** 봐요(release가 UTC 날짜로 골라 `SMOKE_AUDIT_PICK`으로 기준·배포 뒤 스모크에 같은 값을 줘요 — 비교가 맞게). 14곳을 다 보던 때 release 한 번에 ~20만 행이던 감사 읽기가 ~2만 행 안쪽이에요. 모든 거점을 보려면 `SMOKE_AUDIT_ALL=1 scripts/smoke.sh`(직접 실행).
9. **요약·기록** — 버전(이전 → 새), 적용한 마이그레이션, 후속 작업 결과, 기준·배포 뒤 스모크, 롤백 대상, 걸린 시간. 운영을 바꿨으면(마이그레이션 적용이나 배포를 시도했으면) `docs/deploys.md`에 한 줄을 더해요. 적용이 실패한 마이그레이션은 `0005_list_json (적용 실패)`처럼 남아요.

### 남은 후속 작업 (`.wrangler/release-pending-hooks.json`)

마이그레이션은 적용했는데 **후속 작업을 시작하기 전에** 멈추면(기준 스모크 FAIL, 트리가 바뀜, 배포됐는데 버전 불명 등 — 배포 여부와 상관없이), 그 마이그레이션의 후속 작업(새 코드가 있어야 도는 백필)을 못 돌린 채로 남아요. 스크립트는 그 명령을 출력하고, 기록 결과 칸에 `(후속 작업 대기: 0005_list_json)`을 붙이고, `.wrangler/release-pending-hooks.json`(gitignore)에 저장해요. **다음 `npm run release`는 이 파일을 읽어 계획에 "지난 실행에서 남음"으로 넣고 배포 뒤에 돌린 다음 비워요** (마이그레이션이 더 남지 않았어도). 배포 뒤 실패한 후속 작업도 같은 파일에 남아요. 손으로 돌렸다면 파일을 지우면 돼요.
- 적용이 **중간에 실패**하면 목록을 다시 읽어 실제로 적용된 것을 가리고, 그것들의 후속 작업만 남겨요. 기록에는 `0005_list_json, 0006_x (적용 실패 — 적용됨: 0005_list_json)`처럼 남아요. 다시 읽기마저 실패하면(적용 여부 불명) 경고하고 남은 마이그레이션 **모두**의 후속 작업을 남겨요(백필은 여러 번 돌려도 같아요) — 기록에는 `(적용 실패 — 적용 여부 불명)`.
- 이 파일에서는 `node scripts/<이름>.mjs` 명령만 받아요. 깨졌거나 다른 명령이 들어 있으면 경고하고, 원본을 `.wrangler/release-pending-hooks.json.corrupt-<UTC 시각>`(예: `.corrupt-20261006T000001Z`)으로 남긴 뒤 맞는 항목만으로 계속해요.

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
  `sql`은 결과에 `name` 열이 있는 읽기 쿼리(`sqlite_master`, `PRAGMA table_info(<표>)`)예요. 0003 이후 마이그레이션은 등록이 **필수**예요 — 빠지면 테스트(CI)가 실패해요.

## 롤백과 한계

- 자동 롤백은 **새 코드가 만든 회귀**에만 반응해요: 배포 전 기준 스모크에 없던 코드 수준 FAIL이 20초 뒤 다시 돌려도 남아 있을 때. 이미 있던 FAIL, 일시 FAIL, 데이터 상태 신호(감사 200 미통과·일부 거점 0곳)만으로는 되돌리지 않아요 — 되돌려도 고쳐지지 않으니까요.
- 자동 롤백 대상은 **이번 배포 직전에 운영 중이던 버전**이에요. 같은 D1 스키마(마이그레이션 적용 전)에서 돌던 버전이고, 마이그레이션은 더하기만 하니 새 스키마에서도 돌아요.
- **마이그레이션은 되돌리지 않아요.** 되돌릴 방법도 없어요 — 그래서 더하기만.
- R66(0008, 적응형 상세 갱신) 앞 버전으로 되돌려도 트리거·D1에 따로 할 일은 없어요 — 옛 코드는 새 열을 모르고 모든 가게를 다시 매주 갱신해요 (아래 "적응형 상세 갱신 (R66)").
- **`wrangler rollback`은 Cron 트리거를 되돌리지 않아요.** 롤백 뒤에도 지금 `wrangler.jsonc`의 `crons`가 남아요. 이전 버전이 다른 주기를 기대하면 손으로 맞춰야 해요 (예: `2f5adde0`은 `*/10`을 기대해요 — 대시보드의 Triggers나 `npx wrangler triggers deploy --triggers "<cron>" …`). `npm run release`의 자동 롤백은 롤백 대상 커밋(`docs/deploys.md`)의 `crons`와 비교해서 다를 때만 되돌릴 값을 알려요(위 8) — 예전처럼 설정에 `* * * * *`·`1-59/2`가 있다는 것만으로 알리지 않아요(2026-10-07 뒤 버전은 모두 `* * * * *`를 기대해요).
- 손으로 다른 버전으로 롤백할 때는 아래 표를 봐요. 0005(`list_json`) 뒤에는 `v1:` 조각을 쓰는 행이 있어서, 그 형식을 모르는 중간 버전은 목록 JSON을 망가뜨려요.

| 버전 | 커밋 | 롤백해도 되나 | 메모 |
|---|---|---|---|
| `67be6cbd` | `c0900b4` | 네 — 단 둘째 트리거를 `1-59/2`로 되돌릴 것 | 2026-10-07 08:49 배포, 채우기 부스트 앞(R63 뒤). `* * * * *`를 그대로 두면 옛 코드가 매 분(5의 배수 빼고) 본 Cron을 돌려요. `R63 뒤 ~ 부스트 앞` 버전(`3d380d02`·`eee78cd5` 등)도 같아요 |
| `6eeb6e06` | `9348f1b` | 네 — 단 둘째 트리거를 `2-59/5`로 되돌릴 것 | 2026-10-06 14:43 배포, R63 앞. `1-59/2`를 그대로 두면 옛 코드가 홀수 분마다 본 Cron을 돌려요 |
| `72a9f970` | `3a4cc93` | 네 — 단 둘째 트리거(`* * * * *`·`1-59/2`·`2-59/5`)를 지울 것 | 2026-10-06 09:24 배포, 0003~0005 뒤, Cron `*/5`. R56 앞 코드라 `controller.cron`을 보지 않아 두 트리거 모두 전체 수집을 돌려요(카카오 호출·D1 읽기 2배) |
| `2f5adde0` | 0005 이전 | 네 (문서로 확인한 안전 대상) | `v1:` 조각을 견뎌요. Cron을 `*/10`으로 같이 바꿔야 해요 |
| `cd11d71`(Task 28) ~ `8fce5cd` 사이 커밋으로 만든 버전 | — | **아니요** | 옛 읽기 코드가 `v1:` 조각에서 틀린 JSON을 내요 |

롤백 명령: `npx wrangler rollback <버전 id> --message "<이유>"` (스크립트 밖에서는 확인 질문이 나와요).

**채우기 부스트 앞 버전으로 되돌렸을 때 — 꼭 할 것**
- `npm run release`의 자동 롤백 대상이 부스트 앞 버전이면(그 커밋의 `crons`가 `1-59/2`) "Cron 트리거를 */5 * * * *, 1-59/2 * * * *(으)로 되돌려야 해요"를 크게 찍고 종료 코드 **3**이에요. 부스트 뒤 버전끼리는 알리지 않아요.
- 둘째 트리거를 `* * * * *`에서 **`1-59/2 * * * *`로 되돌려요** (R63 앞 버전이면 `2-59/5 * * * *` — 아래). 대시보드 Workers → momeokjo → Triggers, 또는 그 커밋의 `wrangler.jsonc`로 `wrangler triggers deploy`. 부스트 앞 코드는 모르는 cron 값(`* * * * *`)을 본 Cron으로 돌려서, 그대로 두면 본 Cron(격자 수집·보충·집계)이 매 분 더 돌아요(카카오·D1 호출 여러 배).
- 부스트를 끄는 것(아래 "채우기 부스트")은 롤백이 아니에요 — vars만 바꿔 배포하면 트리거는 `* * * * *` 그대로 둬도 돼요.

**R63(주 1회 갱신) 앞 버전으로 되돌렸을 때 — 꼭 할 것**
- 자동 롤백 대상이 R63 앞 버전이면(그 커밋의 `crons`가 `2-59/5`) 같은 방식으로 되돌릴 값을 알리고 종료 코드 **3**이에요.
- 둘째 트리거를 `1-59/2 * * * *`에서 **`2-59/5 * * * *`로 되돌려요** (대시보드 Workers → momeokjo → Triggers, 또는 그 커밋의 `wrangler.jsonc`로 `wrangler triggers deploy`). 자동 롤백(`npm run release`)의 대상은 보통 바로 앞 버전 — R63 첫 배포라면 R63 앞 버전(`6eeb6e06`)이에요. 옛 코드는 모르는 cron 값(`1-59/2`)을 본 Cron으로 돌려서, 그대로 두면 본 Cron(격자 수집·보충·집계)이 시간당 30번 더 돌아요(카카오·D1 호출 여러 배).
- `meta hub_refreshed:*`·`cron_detail_last`는 남아 있어도 옛 코드에 해가 없어요.

**R56(스냅샷) 앞 버전으로 되돌렸을 때 추가로 할 것**
1. 대시보드 Workers → momeokjo → Triggers에서 둘째 트리거(`* * * * *`·`1-59/2`, R63 전이면 `2-59/5`)를 지워요 (또는 `*/5`만 둔 설정으로 `wrangler triggers deploy`).
2. 이 버전(스냅샷 포함)을 다시 올리기 **전에** 남은 스냅샷을 비워요 — 되돌린 동안의 변화가 스냅샷에 빠져 있어요: `npx wrangler d1 execute momeokjo --remote --command "DELETE FROM hub_snapshots"`.
3. `daily_stats`·`anon_first_seen`·`hub_snapshots` 표는 남아 있어도 옛 코드에 해가 없어요.

## 새 거점 공개 순서 (R62)

거점은 `shared/hubs.ts`에 `ready: false`(준비 중)와 갱신 요일 `refreshDay`(아래 "주 1회 갱신")를 넣어 한 줄로 더해요. 준비 중 거점은 화면·공유 링크·`/api/places`(400)에서 보이지 않고, Cron은 계속 채워요.

지금 준비 중 거점은 없어요 — 시청역·을지로입구역(2026-10-09 추가)은 2026-10-10에 공개했어요. 역삼역·선정릉역(2026-10-08 추가)과 선릉역·삼성역(2026-10-09 추가)은 감사 Q1·Q2를 통과해 2026-10-09에 공개했어요. 다음 순서(사용자 결정 2026-10-09): 구로디지털단지역·가산디지털단지역 (새 지역이라 주간 갱신 여유를 보고 사용자에게 확인). 강남역·여의도역·광화문역은 감사 Q1·Q2를 통과해 2026-10-08에 공개했어요. 아래 `gangnam`은 명령 예시예요 — 역삼역이면 `--hub yeoksam`, 선정릉역이면 `--hub seonjeongneung`.

1. **수집** — Cron이 5분마다 채워요. 빨리 채우려면 `ADMIN_TOKEN=… npm run warm -- --hub gangnam`(또는 관리 화면 운영 탭의 거점 표, "준비 중" 표시가 붙은 줄).
2. **감사 Q1·Q2 통과** — `ADMIN_TOKEN=… npm run audit -- --hub gangnam`이 Q1·Q2를 통과해야 해요. 스모크(토큰 있음)도 준비 중 거점을 감사하지만 `info` 줄로만 보여줘요 (FAIL이 아니라 롤백·중단 사유가 아니에요).
3. **`ready: true`** — 그 거점 줄 하나만 바꿔 커밋해요.
4. **release** — `npm run release` (플래그 필요 없음). 기준 스모크(배포 전 운영)는 `SMOKE_BASELINE=1`로 돌아서, 새로 공개하는 거점을 운영이 아직 400으로 숨기는 것은 `WARN 공개 예정 gangnam: 운영은 아직 숨김 (400)`으로만 알려요(그 거점의 감사도 info). 배포 뒤 스모크(플래그 없음)에서 그 거점이 400이면 `gangnam 500m → 400`이 코드 수준 FAIL이라 자동 롤백하고, 200이어야 하고 0곳이 아니어야 해요.

준비 중 거점이 `/api/places`에서 200이면 스모크의 `준비 중 <id> 목록 숨김 → 200 (기대 400)` 줄이 FAIL(코드 수준)이에요 — 덜 모은 목록이 보이는 회귀라서요. 배포 뒤에 이 줄이 새로 생기면 롤백해요. 거점을 다시 숨길 때(`ready: false`)의 기준 스모크는 반대로 `WARN 숨김 예정 <id>: 운영은 아직 공개 중`이라 역시 플래그 없이 진행해요.

## 주 1회 갱신 (R63)

거점마다 자기 요일(KST)에 격자를 다시 모으고(새 가게·없어진 가게), 그 주에 대상인 가게 정보를 다시 가져와요. 그 요일 00:00 KST부터 그 전에 수집한 격자와 `due_after`(R66 — 가게마다 1·2·4주 주기, 아래 "적응형 상세 갱신")가 그 전인 상세가 대상이고, 다 못 하면 다음 날로 이어 해요. 다 끝내면 `meta hub_refreshed:{거점}`에 기록하고, 화면 상태 줄 아래에 "가게 정보 10월 6일(월) 확인 · 새 가게는 매주 월요일"이 보여요(완료 전에는 "새 가게는 매주 월요일 확인해요").

| 요일 | 거점 |
|---|---|
| 월 | 봉은사역, 선정릉역, 선릉역, 삼성역 |
| 화 | 동대문역사문화공원역 |
| 수 | 판교역, 내방역 |
| 목 | 정부과천청사역, 광화문역, 시청역, 을지로입구역 |
| 금 | 강남역, 역삼역 |
| 토 | 여의도역 |
| 일 | (없음 — 밀린 갱신을 따라잡는 여유 날) |

- **새 거점에 요일 정하기** — `shared/hubs.ts`의 그 거점 줄 끝에 `refreshDay: <0~6>`(0=일, 1=월 … 6=토, KST)을 넣어요. 거점이 적고 가게 수 합이 작은 요일로 골라요 — 한 요일에 큰 거점(2천 곳 넘음)이 둘 몰리면 그 주 갱신이 이틀 넘게 걸려요. 일요일은 비워 두는 게 좋아요. 줄 모양은 `id, name, lat, lng, ready, refreshDay` 순서를 지켜요(`scripts/smoke.sh`가 sed로 읽어요). 요일이 0~6이 아니면 테스트가 실패해요.
- **요일 바꾸기** — 그 줄의 숫자만 바꿔 배포해요. 다음 Cron부터 새 요일의 시작을 기준으로 봐요(지난 완료 기록은 그대로 보이다가 새 요일 갱신을 끝내면 바뀌어요).
- **확인** — 관리 화면 운영 탭 거점 표의 "주간 갱신"(요일·이번 시작), "완료"(이번 갱신 완료 시각 / 진행 중 · 지난 완료), "남은 갱신"(`due_after`가 이번 시작 전인 상세 수 — R66). 갱신 요일 다음 날에도 "남은 갱신"이 크게 남으면 처리량이 모자란 거예요 — 아래 튜닝(`DETAIL_BATCH_SIZE`·`DETAIL_CHAR_BUDGET`)을 cpuTime을 보며 올려요. 새 거점을 채우는 동안(미수집이 먼저라)은 주간 갱신이 멈춰요.
- **배포 직후** — 예전(3일 + 지터) 규칙으로 가져온 상세 중 자기 거점의 이번 시작 전 것은 바로 대상이 되고, 이번 시작 전에 수집한 격자도 다시 모아요(한 번 따라잡기). 격자 따라잡기는 1.5~2시간쯤 걸리고 그동안 그 거점은 스냅샷 대신 지금 경로로 답해 "주변 가게를 더 찾는 중이에요"가 잠깐 보일 수 있어요 — **R63 배포는 저녁(KST)에** 하는 게 좋아요. 완료 기록이 아직 없으니 화면은 요일만 보여요(R66 뒤 문구는 "새 가게는 매주 …요일 확인해요").
- **읽기 몫 (R63)** — 상세만 보충(홀수 분, 부스트 동안은 짝수 분도)은 오늘(UTC) D1 읽기가 `D1_READ_SOFT_CAP` × `DETAIL_ONLY_READ_SHARE`(wrangler.jsonc vars, 지금 0.6 = 180만 행)에 닿으면 그날은 건너뛰어요(운영 탭 "마지막 상세만 보충"에 "읽기 몫"). 본 Cron·스냅샷은 소프트 한도까지 그대로 돌아요. 값은 0 초과 1 이하, 틀리면 0.6.
- **Cron 트리거 (R63)** — 트리거는 두 개 그대로예요: 본 Cron `*/5 * * * *`와 둘째 `* * * * *`(매 분, 2026-10-07 채우기 부스트부터 — 전에는 `1-59/2`, 그 전에는 `2-59/5`). 둘째는 UTC 분으로 나눠요 — 7·17·…·57분은 스냅샷 만들기·새로 하기(시간당 6번), 2·12·…·52분은 스냅샷 새로 하기만(Task 56 — 깨끗한 거점의 만든 시각만, 무거운 만들기는 하지 않아요), 0·5·…·55분은 쉼(본 Cron 분), 나머지 홀수 분 18번/시간은 상세만 보충(주간 갱신 처리량), 나머지 짝수 분 18번/시간은 `DETAIL_ONLY_EXTRA`가 `"1"`일 때만 상세만 보충이고 아니면 쉼. 관리 화면 운영 탭의 "마지막 상세만 보충"이 그 실행이에요. 배포(`wrangler deploy`)가 트리거를 바꿔요.
- **채우기 부스트 (2026-10-07 켬 → 2026-10-08 끔)** — 2026-10-08 KST 새벽, 매 분 도는 Cron이 실행마다 무료 플랜 CPU 한도(~10ms)를 넘기자 Cloudflare가 한도를 엄격히 걸어 Cron이 거의 모두 `exceededCpu`로 끊기고(1시간 45분 동안 보충 0), 가벼운 요청까지 가끔 503이 났어요. 그래서 `DETAIL_ONLY_EXTRA` `"0"`·`DETAIL_BATCH_SIZE` `"4"`·`DETAIL_CHAR_BUDGET` `"200000"`으로 되돌렸어요. 다시 켜지 마세요 — 무료 플랜에서는 실행 수·실행당 CPU를 늘리는 것이 오히려 멈춤을 불러요. 아래는 켰을 때의 기록: 준비 중 거점 3곳의 미수집 ~3,300곳을 빨리 채우려고 켰어요: `wrangler.jsonc` vars `DETAIL_ONLY_EXTRA` `"1"`(짝수 분도 상세만 보충 → 시간당 42번) + `DETAIL_BATCH_SIZE` `"6"`(평소 4). 처리량 상한은 (상세만 42 + 본 Cron 12) × 6 ≈ **시간당 ~330곳**이지만, 부스트 동안 글자 예산 `DETAIL_CHAR_BUDGET`도 400,000자로 올려(평소 200,000) 실행당 ~6곳을 받아요 — 실행당 CPU가 늘어나니 Workers 로그의 cpuTime·`exceededCpu`(503)를 지켜보고, 끊기면 글자 예산·배치부터 되돌려요(Cron 로그 줄의 `deferred`가 글자 예산으로 남긴 곳). 카카오 상세 호출은 분당 ~5~6번(전에는 ~2번), D1 읽기는 하루 +~0.5M행(상세만 실행 실행당 ~1천 행 × 하루 +576번 — 읽기 몫 `DETAIL_ONLY_READ_SHARE`가 그대로 막아 줘요). 관리 화면 운영 탭 거점 표의 미수집이 0이 되면 끄세요.
  - **끄기** — `wrangler.jsonc` vars를 `"DETAIL_ONLY_EXTRA": "0"`, `"DETAIL_BATCH_SIZE": "4"`, `"DETAIL_CHAR_BUDGET": "200000"`으로 바꿔 커밋하고 `npm run release`. 트리거(`* * * * *`)는 그대로 둬도 돼요 — 짝수 분은 쉼이라 예전 `1-59/2`와 같은 일을 해요(쉬는 실행은 D1·카카오 호출 없음).
  - 부스트 동안 실패 재시도(R9)는 배치 맨 앞 자리라 글자 예산이 배치 뒤쪽을 남겨도 밀리지 않아요.

### 쿼드트리 깊이 5 반영 (광화문 격자 16698:45349)

`MAX_QUAD_DEPTH`를 4에서 5로 올렸어요(R2). 한 건물의 가게가 같은 좌표에 몰려 포화로 남아 있던 광화문 격자 `16698:45349`(운영 `tiles`에서 `saturated = 1`인 유일한 행)는 **D1을 손대지 않고** 다음 광화문 주간 갱신(목요일 00:00 KST)에서 다시 수집돼요. 이 격자만 주 +4쯤 카카오 로컬 호출이 늘고, 다시 모은 뒤 `saturated`가 0이 되는지(관리 화면 `saturatedTiles`·Q1)를 확인해요. 같은 좌표에 45곳 넘게 찍힌 건물이 생기면 깊이를 올려도 포화로 남아요 — 그건 Q1이 잡아요.

## 적응형 상세 갱신 (R66, 마이그레이션 0008)

가게 정보(상세)를 가게마다 1·2·4주 주기로, 바뀌는 만큼만 다시 가져와요. 상세를 저장할 때 화면에 보이는 정보의 지문(리뷰 수·사진 제외)이 지난번과 같으면 주기를 두 배(최대 4주)로, 다르면 1주로 해요. 열어 본 가게(단건 조회)가 7일보다 오래됐으면 화면은 저장된 그대로 보여주고 뒤에서 그 한 곳만 다시 가져와요(주기 1주로). 격자 재수집(새 가게)은 그대로 매주예요.

- **마이그레이션 0008** (`migrations/0008_adaptive_refresh.sql`) — `places`에 `interval_weeks`(기본 1)·`fp`·`due_after` 열과 `idx_places_status_due` 인덱스를 더하고, 지금 행은 `due_after = fetched_at`으로 채워요(모두 주기 1 — 대상 판단이 예전과 같아요). 후속 작업은 없어요. `npm run release`가 적용 전에는 없고 적용 뒤에는 있는지 확인해요(`scripts/migrationChecks.mjs`). **쓰기 ≈ 가게 수 × 2행**(UPDATE + 인덱스 — 1.6만 곳이면 ~3.2만 행, 하루 쓰기 한도 10만의 1/3)이라 그날 쓰기가 많지 않은 때 적용해요. 읽기는 가게 수만큼.
- **적용과 배포 사이** — 옛 코드가 그사이 쓴 행은 `due_after`가 NULL이에요. 새 코드는 어디서나 `fetched_at`으로 봐서 따로 할 일이 없어요(원하면 배포 뒤 `UPDATE places SET due_after = fetched_at WHERE due_after IS NULL`로 채워도 같아요). 배포 뒤 첫 Cron은 만료 커서를 처음부터 한 번 읽어요(커서 판이 바뀜 — 실행 하나 ≤ 900행).
- **확인** — 관리 화면 운영 탭 "상세 갱신 (바뀌는 만큼만)": 최근 7일(UTC) 다시 가져온 수·바뀐 비율·처음 가져온 수와 주기 분포(거점 격자 가게, 거점 상태와 같이 15분마다 셈). 첫 주는 모두 "처음"(지문을 쌓는 중), 둘째 주부터 "다시 가져옴"이 생기고, 셋째 주부터 2·4주 주기 가게가 주를 건너뛰어 상세 호출이 줄어요 — 가게 id 위상으로 주마다 고르게 나뉘어 한 주에 몰리지 않아요(정상 상태는 5~6주 뒤, 바뀐 비율에 따라 예전의 ~35~64%). "남은 갱신"은 이번 주에 대상인 가게만 세요.
- **롤백** — 옛 코드는 새 열을 모르고 모든 가게를 다시 매주 갱신해요(마이그레이션은 그대로 둬도 돼요, Cron 트리거는 바뀌지 않았어요). 옛 코드가 쓴 행은 주기 1·지문 없음·`due_after` NULL이 되니 R66을 다시 배포하면 그 가게들은 처음처럼 시작해요. 운영 탭 계수 키(`meta detail_*:{날짜}`)는 남아 있어도 해가 없어요(90일 뒤 지워요).

## 손으로 D1을 고칠 때 (Task 34)

- `places` 행을 손으로 지우면(`DELETE FROM places …`) 그 가게는 다시 "미수집"이 돼요. Cron은 미수집을 앞선 커서(`meta.unfetched_from`)부터 찾아서, 커서 앞 칸에 다시 생긴 미수집은 보지 못해요. **같이 커서와 "미수집 확인 끝" 표시도 지워요** (다음 Cron이 처음부터 다시 찾아요):
  `npx wrangler d1 execute momeokjo --remote --command "DELETE FROM meta WHERE key = 'unfetched_from'"` (예전 `unfetched_cleared_at` 키는 더 쓰지 않아요 — 남아 있어도 무시해요)
  거점 스냅샷도 지워요 — 스냅샷 Cron은 표시가 그대로인 스냅샷을 다시 만들지 않고 시각만 새로 해서(R56 새로 하기), 손으로 생긴 미수집을 모르고 pending 0이라는 본문을 내보내요. 안전망(마지막으로 다시 만든 지 24시간이면 다시 만듦)이 늦어도 하루 안에 바로잡지만, 바로 맞추려면: `npx wrangler d1 execute momeokjo --remote --command "DELETE FROM hub_snapshots"`
- 격자 ID(`tile_places`)를 앱이 아닌 SQL로 넣을 때도 같아요 — 앱(`replaceTilePlaces`)은 `tiles_changed_at`을 올려서 커서가 저절로 처음부터 읽어요.
- 격자 상태(`tiles`) 행을 손으로 지우거나 `collected_at`을 되돌리면 **`meta.tiles_fresh`도 지워요** (Task 40 — 본 Cron은 "수집할 격자 없음"을 확인한 뒤 한 시간 동안, 거점 갱신 시작이 지나지 않는 한 격자 확인을 건너뛰어요. 지우지 않아도 한 시간 안에 다시 확인해요):
  `npx wrangler d1 execute momeokjo --remote --command "DELETE FROM meta WHERE key = 'tiles_fresh'"`
- 상세 보충 양은 `wrangler.jsonc` vars `DETAIL_BATCH_SIZE`(지금 4)·`DETAIL_CHAR_BUDGET`(지금 200000)로 정해요. 운영 Workers 로그의 cpuTime(warm·Cron)과 Cron 로그 줄의 `deferred`·`chars`를 보고 올려요.
  - **`DETAIL_BATCH_SIZE`의 천장은 8이에요** (`worker/config.ts` `MAX_DETAIL_BATCH_SIZE`). 더 크게 적어도 8로 잘라요 — 무료 플랜은 실행 하나에 D1 질의 50개라서, 보통 Cron 실행이 만료 갱신·격자 수집·미수집 찾기·집계를 다 하고도 보충 최악(곳마다 한 곳씩 다시 저장 + 차단 기록)이 들어가는 가장 큰 값이에요. 실행마다 남은 D1 호출에 맞춰 더 작아질 수 있어요(하루 한 번 보관 정리 실행은 6곳). 이번 실행의 배치는 Cron 로그 줄의 `batch`예요.
  - 관리 화면 운영 탭 "마지막 Cron"에 **저장 오류**나 **D1 예산으로 건너뜀**(만료 갱신·미수집 찾기·집계) 알약이 보이면 Workers 로그에서 원인을 봐요. 건너뛴 단계는 다음 실행이 이어 해요.

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
npx wrangler d1 execute momeokjo --remote --command "SELECT type,name FROM sqlite_master WHERE name IN ('meta','events','idx_places_status_fetched_at','idx_events_day','idx_events_type_day','daily_stats','anon_first_seen','hub_snapshots','idx_places_status_due')"
#   남은 마이그레이션의 객체가 이미 있으면 멈추고 손으로 맞춰요
npx wrangler d1 migrations apply momeokjo --remote   # 완전히 성공해야 해요. 다시 list → 남은 것 없음, 위 확인 쿼리·PRAGMA table_info(places)
npx wrangler deployments list    # 지금 100% 버전 id를 적어 둬요 (롤백 대상)
npm run deploy                   # 새 Current Version ID를 적어 둬요
ADMIN_TOKEN=… npm run backfill -- --hub ddp --limit 150      # 0005를 이번에 적용했으면 거점마다
B=https://mmj.itmz.me scripts/smoke.sh                       # FAIL 0이어야. 아니면 npx wrangler rollback <적어 둔 id>
```

토큰은 `read -rs ADMIN_TOKEN && export ADMIN_TOKEN`으로 화면에 남기지 않고 넣어요. 운영자 런북 원본은 `.superpowers/sdd/deploy-runbook.md`(로컬, 저장소에는 없음)에 있어요.

## CI (GitHub Actions)

`.github/workflows/ci.yml`: 모든 푸시와 PR에서 Node 26, `npm ci`(npm 캐시), `npm run typecheck`, `npm test`, `npm run build`, 빌드 결과가 있고 `%VITE_` 자리표시자가 없는지 확인(파일이 없으면 실패).
- `test/shared/release.test.ts`가 0003 이후의 모든 `migrations/*.sql`에 `scripts/migrationChecks.mjs` 항목이 있는지 봐요 — 등록 없이 새 마이그레이션을 합치면 CI가 실패해요.
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
