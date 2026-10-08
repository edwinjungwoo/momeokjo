import { describe, expect, it } from "vitest";
import { MIGRATION_CHECKS, objectState } from "../../scripts/migrationChecks.mjs";
import {
  classifySmokeFails,
  confirmRollback,
  deployLogLine,
  dirtyPaths,
  formatDuration,
  isD1LimitError,
  isDataStateFail,
  isDestructive,
  kstStamp,
  parseActiveVersion,
  parseD1Rows,
  parseDeployVersionId,
  parsePendingHooks,
  parsePendingMigrations,
  parseReleaseArgs,
  parseSecretNames,
  parseSmokeFails,
  parseSmokeSummary,
  planRelease,
  shouldRollback,
  smokeFailKey,
} from "../../scripts/release.mjs";
import {
  D1_LIMIT_ERROR,
  D1_SELECT_1,
  DEPLOY_OUTPUT,
  DEPLOYMENTS_PRETTY,
  deploymentsJson,
  FAIL_ASSET_NEW,
  FAIL_ASSET_OLD,
  emptyFail,
  FAIL_AUDIT,
  FAIL_AUDIT_000,
  FAIL_AUDIT_401,
  FAIL_AUDIT_500,
  FAIL_EMPTY,
  FAIL_PLACES_000,
  FAIL_PLACES_500,
  MIGRATIONS_NONE,
  MIGRATIONS_PENDING,
  MIGRATIONS_PENDING_0005_ANSI,
  NEW_VERSION,
  PREV_VERSION,
  SECRETS_JSON,
  smokeOutput,
} from "../fixtures/wrangler-output";

import smokeSh from "../../scripts/smoke.sh?raw";
import hubsTs from "../../shared/hubs.ts?raw";
import { HUBS as ALL_HUBS } from "../../shared/hubs";

const MIGRATION_SQL = import.meta.glob("../../migrations/*.sql", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const sqlOf = (name: string) => MIGRATION_SQL[`../../migrations/${name}`];
const HUBS = ["bongeunsa", "ddp", "pangyo", "naebang", "gwacheon"];

describe("infra: release 인자", () => {
  it("infra: 기본값은 모두 꺼짐, 플래그를 받는다", () => {
    expect(parseReleaseArgs([])).toEqual({
      ok: true,
      opts: { dryRun: false, skipTests: false, force: false, yes: false, allowDestructive: false, acceptBaselineFails: false },
    });
    expect(parseReleaseArgs(["--dry-run", "--yes", "--allow-destructive", "--accept-baseline-fails"])).toEqual({
      ok: true,
      opts: { dryRun: true, skipTests: false, force: false, yes: true, allowDestructive: true, acceptBaselineFails: true },
    });
  });

  it("infra: --skip-tests는 --force 없이는 거절, 모르는 인자도 거절", () => {
    expect(parseReleaseArgs(["--skip-tests"])).toMatchObject({ ok: false, error: expect.stringContaining("--force") });
    expect(parseReleaseArgs(["--skip-tests", "--force"])).toMatchObject({ ok: true, opts: { skipTests: true, force: true } });
    expect(parseReleaseArgs(["--deploy-now"])).toMatchObject({ ok: false });
  });
});

describe("infra: 마이그레이션 목록 읽기", () => {
  it("infra: 상자 표에서 적용할 마이그레이션 이름을 순서대로 읽는다", () => {
    expect(parsePendingMigrations(MIGRATIONS_PENDING)).toEqual(["0003_meta.sql", "0004_events.sql", "0005_list_json.sql"]);
  });

  it("infra: ANSI 색·CRLF가 섞여도 읽는다", () => {
    expect(parsePendingMigrations(MIGRATIONS_PENDING_0005_ANSI)).toEqual(["0005_list_json.sql"]);
  });

  it("infra: 'No migrations to apply'면 빈 목록", () => {
    expect(parsePendingMigrations(MIGRATIONS_NONE)).toEqual([]);
  });

  it("infra: 표 없이 줄마다 이름만 있어도 읽는다", () => {
    expect(parsePendingMigrations("Migrations to be applied:\n  0006_rollups.sql\n  0007_hub_snapshot.sql\n")).toEqual([
      "0006_rollups.sql",
      "0007_hub_snapshot.sql",
    ]);
  });

  it("infra: 알아볼 수 없는 출력은 null (빈 목록으로 오해하지 않는다)", () => {
    expect(parsePendingMigrations("")).toBeNull();
    expect(parsePendingMigrations("✘ [ERROR] A request to the Cloudflare API failed.")).toBeNull();
    expect(parsePendingMigrations("Migrations to be applied:\n┌──┐\n└──┘\n")).toBeNull();
  });
});

describe("infra: 파괴적인 마이그레이션 거절", () => {
  it("infra: 지금까지의 마이그레이션 0001~0005는 모두 더하기만 한다", () => {
    const names = Object.keys(MIGRATION_SQL);
    expect(names.length).toBeGreaterThanOrEqual(5);
    for (const [name, sql] of Object.entries(MIGRATION_SQL)) expect(isDestructive(sql), name).toEqual([]);
  });

  it("infra: DROP·RENAME·ALTER … DROP·DELETE를 찾는다", () => {
    expect(isDestructive("DROP TABLE events;")).toEqual(["DROP"]);
    expect(isDestructive("drop index idx_events_day;")).toEqual(["DROP"]);
    expect(isDestructive("ALTER TABLE places DROP COLUMN list_json;")).toEqual(["ALTER … DROP"]);
    expect(isDestructive("ALTER TABLE places RENAME TO places_old;")).toEqual(["RENAME"]);
    expect(isDestructive("ALTER TABLE places RENAME COLUMN name TO title;")).toEqual(["RENAME"]);
    expect(isDestructive("DELETE FROM events WHERE day < '2026-01-01';")).toEqual(["DELETE"]);
    expect(isDestructive("CREATE TABLE t (a TEXT);\nDROP TABLE old;\nALTER TABLE x RENAME TO y;")).toEqual(["DROP", "RENAME"]);
  });

  it("infra: 주석·문자열·이름 일부의 drop은 무시한다", () => {
    expect(isDestructive("-- DROP TABLE는 쓰지 않는다\nCREATE TABLE t (dropped_at INTEGER, renamed TEXT);")).toEqual([]);
    expect(isDestructive("/* ALTER TABLE x DROP COLUMN y */ INSERT INTO meta VALUES ('drop', 'rename');")).toEqual([]);
  });
});

describe("infra: wrangler 출력 읽기", () => {
  it("infra: d1 execute --json 결과 행", () => {
    expect(parseD1Rows(D1_SELECT_1)).toEqual([{ "1": 1 }]);
    expect(parseD1Rows("some warning\n" + D1_SELECT_1)).toEqual([{ "1": 1 }]);
    expect(parseD1Rows(D1_LIMIT_ERROR)).toBeNull();
    expect(parseD1Rows("nope")).toBeNull();
  });

  it("infra: JSON 배열 뒤에 다른 글이 붙어도 짝이 맞는 [ … ]만 읽고, 깨진 JSON은 null", () => {
    expect(parseD1Rows(D1_SELECT_1 + '\n🪵  Logs were written to "/tmp/wrangler.log" [ok]\n')).toEqual([{ "1": 1 }]);
    expect(parseSecretNames(SECRETS_JSON + "\nUpdate available! [4.148.0]\n")).toEqual(["ADMIN_TOKEN", "KAKAO_REST_KEY"]);
    expect(parseD1Rows('[{"results": [1, 2')).toBeNull();
    expect(parseD1Rows('[{"results": "]"} garbage')).toBeNull();
    expect(parseSecretNames('[{"name": "a]b"}]')).toEqual(["a]b"]);
  });

  it("infra: D1 일일 한도(7500) 오류를 알아본다", () => {
    expect(isD1LimitError(D1_LIMIT_ERROR)).toBe(true);
    expect(isD1LimitError("✘ [ERROR] D1_ERROR: Exceeded maximum daily rows read limit")).toBe(true);
    expect(isD1LimitError("✘ [ERROR] Authentication error [code: 10000]")).toBe(false);
    expect(isD1LimitError("rows_read: 17500")).toBe(false);
  });

  it("infra: secret list는 이름만 읽는다 (JSON, 표 둘 다)", () => {
    expect(parseSecretNames(SECRETS_JSON)).toEqual(["ADMIN_TOKEN", "KAKAO_REST_KEY"]);
    expect(parseSecretNames('[\n  {\n    "name": "KAKAO_REST_KEY",\n    "type": "secret_text"\n  }\n]')).toEqual(["KAKAO_REST_KEY"]);
    expect(parseSecretNames("garbage")).toBeNull();
  });

  it("infra: 배포 출력의 'Current Version ID:'", () => {
    expect(parseDeployVersionId(DEPLOY_OUTPUT)).toBe(NEW_VERSION);
    expect(parseDeployVersionId("\u001b[2mCurrent Version ID:\u001b[22m 72a9f970-5b1e-4c7d-9a3f-1e2d3c4b5a69")).toBe(NEW_VERSION);
    expect(parseDeployVersionId("Uploaded momeokjo")).toBeNull();
  });

  it("infra: 지금 100% 활성 버전 — JSON은 created_on이 가장 늦은 배포, 표는 마지막 'Version(s):  (100%)'", () => {
    expect(parseActiveVersion(deploymentsJson(PREV_VERSION))).toEqual({ ok: true, id: PREV_VERSION });
    expect(parseActiveVersion(DEPLOYMENTS_PRETTY)).toEqual({ ok: true, id: PREV_VERSION });
    // 순서가 섞여 와도 created_on으로 고른다
    const shuffled = JSON.stringify([...JSON.parse(deploymentsJson(PREV_VERSION))].reverse());
    expect(parseActiveVersion(shuffled)).toEqual({ ok: true, id: PREV_VERSION });
  });

  it("infra: 트래픽이 나뉜 배포·빈 출력은 롤백 대상을 정하지 않는다", () => {
    const split = JSON.stringify([
      { created_on: "2026-10-06T00:00:00Z", versions: [{ version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 }] },
    ]);
    expect(parseActiveVersion(split)).toMatchObject({ ok: false });
    expect(parseActiveVersion("[]")).toMatchObject({ ok: false });
    expect(parseActiveVersion("")).toMatchObject({ ok: false });
  });

  it("infra: 스모크 요약 줄", () => {
    expect(parseSmokeSummary(smokeOutput(0, 2))).toEqual({ requests: 25, fails: 0, warns: 2 });
    expect(parseSmokeSummary(smokeOutput(3))).toEqual({ requests: 25, fails: 3, warns: 1 });
    expect(parseSmokeSummary("curl이(가) 필요해요")).toBeNull();
  });
});

describe("infra: 스모크 FAIL 줄", () => {
  it("infra: smoke.sh의 '  FAIL  …' 줄만 모은다", () => {
    expect(parseSmokeFails(smokeOutput([FAIL_PLACES_500, FAIL_AUDIT]))).toEqual([FAIL_PLACES_500, FAIL_AUDIT]);
    expect(parseSmokeFails(smokeOutput(0))).toEqual([]);
  });

  it("infra: 같은 확인이면 같은 키 — 상태 코드·자산 해시가 달라도", () => {
    expect(smokeFailKey(FAIL_PLACES_500)).toBe(smokeFailKey(FAIL_PLACES_000));
    expect(smokeFailKey(FAIL_ASSET_OLD)).toBe(smokeFailKey(FAIL_ASSET_NEW));
    expect(smokeFailKey(FAIL_PLACES_500)).not.toBe(smokeFailKey("ddp 500m 200인데 0곳"));
  });

  it("infra: 200으로 답했지만 통과 못 한 감사와 '200인데 0곳'은 데이터 상태 신호", () => {
    expect(isDataStateFail(FAIL_AUDIT)).toBe(true);
    expect(isDataStateFail(FAIL_EMPTY)).toBe(true);
    expect(isDataStateFail(FAIL_PLACES_500)).toBe(false);
    expect(isDataStateFail(FAIL_ASSET_NEW)).toBe(false);
  });

  it("infra: 감사 요청 자체가 실패(500·000·401, 200인데 JSON 없음)하면 코드 수준", () => {
    for (const l of [FAIL_AUDIT_500, FAIL_AUDIT_000, FAIL_AUDIT_401, "감사 ddp → 200", "감사 ddp → 200 null"]) expect(isDataStateFail(l), l).toBe(false);
  });

  it("infra: 같은 실행에서 모든 거점이 '200인데 0곳'이면 목록 처리 회귀로 보고 코드 수준", () => {
    const all = HUBS.map(emptyFail);
    expect(classifySmokeFails(all, HUBS)).toEqual({ code: all, data: [] });
    const some = HUBS.slice(0, 4).map(emptyFail);
    expect(classifySmokeFails([...some, FAIL_AUDIT, FAIL_PLACES_500], HUBS)).toEqual({ code: [FAIL_PLACES_500], data: [...some, FAIL_AUDIT] });
    // 거점 목록이 없으면 판단하지 않는다 (줄마다)
    expect(classifySmokeFails(all, [])).toEqual({ code: [], data: all });
  });
});

/** smoke.sh가 hubs.ts 모양 원문에서 거점 줄("id lat lng ready")을 읽는 sed 식을 그대로 돌린다 */
function smokeHubLines(src: string): string[] {
  const m = /sed -nE 's\/(.+?)\/(\\1[^/]*)\/p' "\$HUBS_TS"/.exec(smokeSh);
  expect(m).not.toBeNull();
  const re = new RegExp(m![1]);
  const repl = m![2].replace(/\\(\d)/g, "$$$1");
  return src.split("\n").filter((l) => re.test(l)).map((l) => l.replace(re, repl).trim());
}

describe("R62 준비 중 거점 — 스모크", () => {
  it("R62: smoke.sh는 shared/hubs.ts에서 거점마다 id·좌표·ready를 읽는다 (sed 식을 그대로 돌려 본다)", () => {
    expect(smokeHubLines(hubsTs)).toEqual(ALL_HUBS.map((h) => `${h.id} ${h.lat} ${h.lng} ${h.ready}`));
  });

  it("R62: 준비 중 거점은 목록·감사를 FAIL로 세지 않는다 — 스모크는 info로만 찍고, 모르는 거점 확인은 hubs.ts에 없는 id로", () => {
    // 운영 거점은 모두 공개라(2026-10-08) 준비 중 줄이 하나 있는 hubs.ts 모양 원문으로 본다 — ready는 "false"로 읽혀 아래 `!= true` 쪽으로 간다
    const fixture = [
      '  { id: "bongeunsa", name: "봉은사역", lat: 37.514255, lng: 127.060234, ready: true, refreshDay: 1 },',
      '  { id: "testready", name: "준비중시험역", lat: 33.499621, lng: 126.531188, ready: false, refreshDay: 0 },',
    ].join("\n");
    expect(smokeHubLines(fixture)).toEqual(["bongeunsa 37.514255 127.060234 true", "testready 33.499621 126.531188 false"]);
    // 목록: 준비 중이면 숨김(400)만 확인하고 다음 거점으로
    expect(smokeSh).toMatch(/read -r id _ _ ready <<<"\$h"\n\s+if \[ "\$ready" != true \]; then/);
    // 감사: 준비 중이면 info 줄 (FAIL 줄을 만드는 bad를 부르지 않는다)
    expect(smokeSh).toMatch(/if \[ "\$ready" != true \]; then\n\s+info "감사 \$id\(준비 중\)/);
    // 모르는 거점 400 확인에 실제 거점 id를 쓰지 않는다
    const unknown = /expect_code hubx 400 "[^"]*" "\$B\/api\/places\?hub=([a-z0-9-]+)&/.exec(smokeSh);
    expect(unknown).not.toBeNull();
    expect(ALL_HUBS.some((h) => h.id === unknown![1])).toBe(false);
    // 준비 중 거점 줄이 info·ok뿐이면 FAIL로 모이지 않는다
    const out = smokeOutput([]).replace(
      "== 정적 파일",
      ["== 정적 파일", "  ok    준비 중 testready 목록 숨김 → 400", '  info  감사 testready(준비 중) → 200 {"pass":{"q1":false,"q2":false}}'].join("\n"),
    );
    expect(parseSmokeFails(out)).toEqual([]);
  });

  it("R62: 준비 중 거점 목록이 200이면 코드 수준 FAIL이라(데이터 상태 아님) 기준에 없던 줄이면 롤백 판단이다", () => {
    const leak = "준비 중 testready 목록 숨김 → 200 (기대 400)";
    const pub = ALL_HUBS.filter((h) => h.ready).map((h) => h.id);
    expect(isDataStateFail(leak)).toBe(false);
    expect(classifySmokeFails([leak], pub)).toEqual({ code: [leak], data: [] });
    const s = { requests: 25, fails: 1, warns: 0 };
    expect(shouldRollback({ code: 1, summary: s, fails: [leak], baseline: [], hubIds: pub })).toMatchObject({ action: "rollback", newFails: [leak] });
    // 같은 줄이 기준에도 있었으면(--accept-baseline-fails로 받아들임) 새 FAIL이 아니다
    expect(shouldRollback({ code: 1, summary: s, fails: [leak], baseline: [leak], hubIds: pub })).toMatchObject({ action: "keep" });
  });

  it("R62: 배포 뒤 공개 거점의 400(코드 FAIL)은 롤백 판단이다 — 기준에서는 WARN이라 줄 자체가 없다", () => {
    const pub = ALL_HUBS.filter((h) => h.ready).map((h) => h.id);
    const f = "gangnam 500m → 400";
    expect(isDataStateFail(f)).toBe(false);
    expect(shouldRollback({ code: 1, summary: { requests: 25, fails: 1, warns: 0 }, fails: [f], baseline: [], hubIds: pub })).toMatchObject({ action: "rollback" });
  });

  it("R62: smoke.sh는 SMOKE_BASELINE=1(기준 실행)에서만 운영과 로컬 ready 차이를 WARN으로 낮추고, hubs.ts를 못 읽어 내장 목록을 쓰면 알린다", () => {
    expect(smokeSh).toMatch(/\[ "\$\{SMOKE_BASELINE:-\}" = 1 \] && baseline=true/);
    expect(smokeSh).toMatch(/if \$baseline && \[ "\$code" = 400 \]; then\n\s+# [^\n]*\n\s+warn "공개 예정 \$id: 운영은 아직 숨김 \(400\)"/);
    expect(smokeSh).toMatch(/warn "숨김 예정 \$id: 운영은 아직 공개 중/);
    // 기준 아닌 실행의 숨김 확인은 expect_code (FAIL)
    expect(smokeSh).toMatch(/else\n\s+expect_code "hidden-\$id" 400 "준비 중 \$id 목록 숨김"/);
    // 공개 예정 거점의 감사는 info
    expect(smokeSh).toMatch(/info "감사 \$id\(공개 예정, 운영은 아직 숨김\)/);
    // hubs.ts가 있는데 내장 목록으로 떨어지면 WARN
    expect(smokeSh).toMatch(/if \[ -f "\$HUBS_TS" \]; then warn "shared\/hubs\.ts에서 거점을 읽지 못해 내장 목록으로/);
  });

  it("R62: '모든 거점 0곳'(코드 수준) 판단은 스모크가 목록을 본 공개 거점 기준이다", () => {
    const pub = ALL_HUBS.filter((h) => h.ready).map((h) => h.id);
    const all = pub.map(emptyFail);
    expect(classifySmokeFails(all, pub)).toEqual({ code: all, data: [] });
  });
});

describe("infra: 롤백 전에 한 번 더 (일시 FAIL 거르기)", () => {
  const s = (fails: string[]) => ({ code: fails.length ? 1 : 0, summary: { requests: 25, fails: fails.length, warns: 0 }, fails });

  it("infra: 다시 돌린 스모크에도 남은 새 코드 FAIL(교집합)만으로 롤백", () => {
    expect(confirmRollback({ first: [FAIL_PLACES_500, FAIL_ASSET_NEW], rerun: s([FAIL_PLACES_000]), baseline: [], hubIds: HUBS })).toMatchObject({
      action: "rollback",
      newFails: [FAIL_PLACES_000],
    });
  });

  it("infra: 다시 돌리니 사라졌으면 그대로 (일시 FAIL)", () => {
    expect(confirmRollback({ first: [FAIL_PLACES_500], rerun: s([]), baseline: [], hubIds: HUBS })).toMatchObject({ action: "keep" });
  });

  it("infra: 다시 돌린 결과를 못 읽으면 manual, 다른 코드 FAIL만 새로 보이면(흔들림) manual, 데이터 신호만 남으면 data", () => {
    expect(confirmRollback({ first: [FAIL_PLACES_500], rerun: { code: 2, summary: null, fails: [] }, baseline: [], hubIds: HUBS })).toMatchObject({ action: "manual" });
    expect(confirmRollback({ first: [FAIL_PLACES_500], rerun: s([FAIL_ASSET_NEW]), baseline: [], hubIds: HUBS })).toMatchObject({ action: "manual" });
    expect(confirmRollback({ first: [FAIL_PLACES_500], rerun: s([FAIL_AUDIT]), baseline: [], hubIds: HUBS })).toMatchObject({ action: "data", newFails: [FAIL_AUDIT] });
  });
});

describe("infra: 스모크 뒤 롤백 판단 (배포 전 기준과 비교)", () => {
  const s = (fails: string[], warns = 0) => ({ requests: 25, fails: fails.length, warns });
  it("infra: 기준에 없던 코드 수준 FAIL이 생기면 롤백", () => {
    expect(shouldRollback({ code: 1, summary: s([FAIL_PLACES_500]), fails: [FAIL_PLACES_500], baseline: [] })).toMatchObject({
      action: "rollback",
      newFails: [FAIL_PLACES_500],
    });
  });

  it("infra: 배포 전부터 있던 FAIL은 롤백 사유가 아니다 (상태 코드·자산 해시가 바뀌어도 같은 확인)", () => {
    expect(shouldRollback({ code: 1, summary: s([FAIL_PLACES_000, FAIL_ASSET_NEW]), fails: [FAIL_PLACES_000, FAIL_ASSET_NEW], baseline: [FAIL_PLACES_500, FAIL_ASSET_OLD] })).toMatchObject({
      action: "keep",
      newFails: [],
    });
  });

  it("infra: 새로 생긴 FAIL이 데이터 상태 신호(감사·0곳)뿐이면 롤백하지 않고 data", () => {
    expect(shouldRollback({ code: 1, summary: s([FAIL_AUDIT, FAIL_EMPTY]), fails: [FAIL_AUDIT, FAIL_EMPTY], baseline: [] })).toMatchObject({
      action: "data",
      newFails: [FAIL_AUDIT, FAIL_EMPTY],
    });
    // 코드 FAIL과 섞이면 롤백
    expect(shouldRollback({ code: 1, summary: s([FAIL_AUDIT, FAIL_PLACES_500]), fails: [FAIL_AUDIT, FAIL_PLACES_500], baseline: [] })).toMatchObject({
      action: "rollback",
      newFails: [FAIL_PLACES_500],
    });
  });

  it("infra: FAIL 0·종료 코드 0이면 그대로 (WARN은 상관없음)", () => {
    expect(shouldRollback({ code: 0, summary: s([], 4), fails: [], baseline: [] })).toMatchObject({ action: "keep" });
  });

  it("infra: 기준과 같은 확인이라도 분류가 데이터 → 코드로 바뀌면 새 FAIL (반대면 data)", () => {
    // 배포 전: 감사가 200으로 답했지만 미통과 (데이터) → 배포 뒤: 감사 요청 자체가 500 (코드)
    expect(shouldRollback({ code: 1, summary: s([FAIL_AUDIT_500]), fails: [FAIL_AUDIT_500], baseline: [FAIL_AUDIT], hubIds: HUBS })).toMatchObject({
      action: "rollback",
      newFails: [FAIL_AUDIT_500],
    });
    // 배포 전: 500 (코드) → 배포 뒤: 200 미통과 (데이터) — 새 줄이지만 데이터 신호
    expect(shouldRollback({ code: 1, summary: s([FAIL_AUDIT]), fails: [FAIL_AUDIT], baseline: [FAIL_AUDIT_500], hubIds: HUBS })).toMatchObject({ action: "data" });
    // 같은 분류로 그대로면 새 FAIL 아님
    expect(shouldRollback({ code: 1, summary: s([FAIL_AUDIT]), fails: [FAIL_AUDIT], baseline: [FAIL_AUDIT], hubIds: HUBS })).toMatchObject({ action: "keep" });
  });

  it("infra: 새 감사 HTTP 실패는 코드 수준이라 롤백, 모든 거점 '0곳'도 롤백", () => {
    expect(shouldRollback({ code: 1, summary: s([FAIL_AUDIT_500]), fails: [FAIL_AUDIT_500], baseline: [], hubIds: HUBS })).toMatchObject({
      action: "rollback",
      newFails: [FAIL_AUDIT_500],
    });
    const all = HUBS.map(emptyFail);
    expect(shouldRollback({ code: 1, summary: s(all), fails: all, baseline: [], hubIds: HUBS })).toMatchObject({ action: "rollback", newFails: all });
  });

  it("infra: 요약을 못 읽었거나, FAIL 줄 수가 요약과 다르거나, 종료 코드와 어긋나면 사람이 본다", () => {
    expect(shouldRollback({ code: 2, summary: null, fails: [], baseline: [] })).toMatchObject({ action: "manual" });
    expect(shouldRollback({ code: 1, summary: s([]), fails: [], baseline: [] })).toMatchObject({ action: "manual" });
    expect(shouldRollback({ code: 1, summary: { requests: 25, fails: 2, warns: 0 }, fails: [], baseline: [] })).toMatchObject({ action: "manual" });
  });
});

describe("infra: 작업 트리 확인", () => {
  it("infra: docs/deploys.md와 .claude/는 무시하고 나머지 변경은 모두 잡는다", () => {
    expect(dirtyPaths("")).toEqual([]);
    expect(dirtyPaths(" M docs/deploys.md\n?? .claude/\n")).toEqual([]);
    expect(dirtyPaths(" M worker/index.ts\n?? migrations/0006_x.sql\n M docs/deploys.md\n")).toEqual(["worker/index.ts", "migrations/0006_x.sql"]);
    expect(dirtyPaths("R  old.ts -> new.ts\n")).toEqual(["new.ts"]);
  });
});

describe("infra: 마이그레이션별 확인·후속 작업 목록", () => {
  it("infra: 등록된 이름은 실제 마이그레이션 파일이다", () => {
    for (const name of Object.keys(MIGRATION_CHECKS)) expect(sqlOf(name), name).toBeTypeOf("string");
    expect(Object.keys(MIGRATION_CHECKS)).toEqual(expect.arrayContaining(["0003_meta.sql", "0004_events.sql", "0005_list_json.sql"]));
  });

  it("infra: 0003 이후 모든 마이그레이션 파일에 확인 항목이 있다 (새 마이그레이션을 등록 없이 합치면 CI가 실패)", () => {
    const files = Object.keys(MIGRATION_SQL).map((p) => p.split("/").pop()!);
    const numbered = files.filter((f) => /^\d{4}_/.test(f) && Number(f.slice(0, 4)) >= 3);
    expect(numbered).toEqual(expect.arrayContaining(["0003_meta.sql", "0005_list_json.sql"]));
    for (const f of numbered) expect(MIGRATION_CHECKS[f], `scripts/migrationChecks.mjs에 ${f} 항목이 없어요`).toBeDefined();
  });

  it("infra: 0003은 meta 테이블, 0005는 places.list_json 열을 확인하고 0005만 백필 후속 작업이 있다", () => {
    const c3 = MIGRATION_CHECKS["0003_meta.sql"];
    expect(c3.checks.flatMap((c) => c.expect)).toEqual(expect.arrayContaining(["meta", "idx_places_status_fetched_at"]));
    expect(c3.hooks ?? []).toEqual([]);
    const c5 = MIGRATION_CHECKS["0005_list_json.sql"];
    expect(c5.checks).toEqual([expect.objectContaining({ sql: "PRAGMA table_info(places)", expect: ["list_json"] })]);
    expect(c5.hooks).toHaveLength(1);
    expect(c5.hooks![0].commands(["ddp", "pangyo"])).toEqual([
      { cmd: "node", args: ["scripts/backfill.mjs", "--hub", "ddp", "--limit", "150"] },
      { cmd: "node", args: ["scripts/backfill.mjs", "--hub", "pangyo", "--limit", "150"] },
    ]);
  });

  it("infra: objectState — 기대한 이름이 모두·일부·하나도 없는지", () => {
    expect(objectState([{ name: "meta" }, { name: "idx_places_status_fetched_at" }], ["meta", "idx_places_status_fetched_at"])).toBe("all");
    expect(objectState([{ name: "meta" }], ["meta", "idx_places_status_fetched_at"])).toBe("partial");
    expect(objectState([{ name: "id" }, { name: "name" }], ["list_json"])).toBe("none");
  });
});

describe("infra: 배포 계획", () => {
  it("infra: 적용할 마이그레이션이 없으면 마이그레이션·후속 작업을 건너뛴다", () => {
    const plan = planRelease({ pending: [], sqlByName: {}, allowDestructive: false, hubIds: HUBS, hasAdminToken: false });
    expect(plan).toMatchObject({ ok: true, errors: [], migrations: [], hooks: [] });
    expect(plan.lines.join("\n")).toContain("건너뜀");
  });

  it("infra: 0005가 남았으면 적용·확인 뒤 거점마다 --limit 150 백필", () => {
    const plan = planRelease({
      pending: ["0005_list_json.sql"],
      sqlByName: { "0005_list_json.sql": sqlOf("0005_list_json.sql") },
      allowDestructive: false,
      hubIds: HUBS,
      hasAdminToken: true,
    });
    expect(plan.ok).toBe(true);
    expect(plan.migrations).toEqual(["0005_list_json.sql"]);
    expect(plan.hooks.map((h) => h.args.join(" "))).toEqual(HUBS.map((id) => `scripts/backfill.mjs --hub ${id} --limit 150`));
    expect(plan.hooks[0]).toMatchObject({ migration: "0005_list_json.sql", cmd: "node" });
    expect(plan.lines.join("\n")).toContain("0005_list_json.sql");
  });

  it("infra: 파괴적인 마이그레이션은 --allow-destructive 없이는 계획이 거절된다", () => {
    const input = { pending: ["0006_drop.sql"], sqlByName: { "0006_drop.sql": "DROP TABLE events;" }, hubIds: HUBS, hasAdminToken: true };
    const refused = planRelease({ ...input, allowDestructive: false });
    expect(refused.ok).toBe(false);
    expect(refused.errors.join("\n")).toMatch(/0006_drop\.sql.*DROP.*--allow-destructive/);
    expect(planRelease({ ...input, allowDestructive: true }).ok).toBe(true);
  });

  it("infra: SQL 파일을 못 읽으면 거절", () => {
    expect(planRelease({ pending: ["0009_x.sql"], sqlByName: {}, allowDestructive: false, hubIds: HUBS, hasAdminToken: true }).ok).toBe(false);
  });

  it("infra: 후속 작업에 관리자 토큰이 필요한데 없으면 거절", () => {
    const plan = planRelease({
      pending: ["0005_list_json.sql"],
      sqlByName: { "0005_list_json.sql": sqlOf("0005_list_json.sql") },
      allowDestructive: false,
      hubIds: HUBS,
      hasAdminToken: false,
    });
    expect(plan.ok).toBe(false);
    expect(plan.errors.join("\n")).toContain("ADMIN_TOKEN");
  });
});

describe("infra: 지난 실행에서 남은 후속 작업", () => {
  const carried = [{ migration: "0005_list_json.sql", name: "list_json 백필", cmd: "node", args: ["scripts/backfill.mjs", "--hub", "ddp", "--limit", "150"], needsAdminToken: true }];

  it("infra: 적용할 마이그레이션이 없어도 남은 후속 작업을 계획에 넣는다", () => {
    const plan = planRelease({ pending: [], sqlByName: {}, allowDestructive: false, hubIds: HUBS, hasAdminToken: true, carriedHooks: carried });
    expect(plan.ok).toBe(true);
    expect(plan.hooks.map((h) => h.args.join(" "))).toEqual(["scripts/backfill.mjs --hub ddp --limit 150"]);
    expect(plan.lines.join("\n")).toContain("지난 실행");
  });

  it("infra: 같은 명령은 한 번만, 토큰이 필요하면 확인", () => {
    const plan = planRelease({
      pending: ["0005_list_json.sql"],
      sqlByName: { "0005_list_json.sql": sqlOf("0005_list_json.sql") },
      allowDestructive: false,
      hubIds: ["ddp"],
      hasAdminToken: true,
      carriedHooks: carried,
    });
    expect(plan.hooks).toHaveLength(1);
    expect(planRelease({ pending: [], sqlByName: {}, allowDestructive: false, hubIds: HUBS, hasAdminToken: false, carriedHooks: carried }).ok).toBe(false);
  });

  it("infra: 상태 파일 읽기 — 없으면 빈 목록, 깨졌으면 빈 목록 + corrupt", () => {
    expect(parsePendingHooks(JSON.stringify(carried))).toEqual({ hooks: carried, corrupt: false });
    expect(parsePendingHooks(undefined)).toEqual({ hooks: [], corrupt: false });
    expect(parsePendingHooks("not json")).toEqual({ hooks: [], corrupt: true });
    expect(parsePendingHooks('{"a": 1}')).toEqual({ hooks: [], corrupt: true });
    expect(parsePendingHooks('[{"cmd": 1}]')).toEqual({ hooks: [], corrupt: true });
  });

  it("infra: 허용 목록 — node scripts/<이름>.mjs만 (다른 명령·경로 탈출은 버리고 corrupt)", () => {
    const bad = [
      { ...carried[0], cmd: "bash", args: ["-c", "echo hi"] },
      { ...carried[0], args: ["scripts/../../x.mjs"] },
      { ...carried[0], args: ["/tmp/x.mjs"] },
      { ...carried[0], args: ["-e", "1"] },
    ];
    expect(parsePendingHooks(JSON.stringify([...carried, ...bad]))).toEqual({ hooks: carried, corrupt: true });
  });
});

describe("infra: 배포 기록", () => {
  it("infra: KST 시각·걸린 시간", () => {
    expect(kstStamp(Date.UTC(2026, 9, 6, 0, 24))).toBe("2026-10-06 09:24");
    expect(kstStamp(Date.UTC(2026, 9, 5, 15, 30))).toBe("2026-10-06 00:30");
    expect(formatDuration(243_400)).toBe("4분 3초");
    expect(formatDuration(9_000)).toBe("9초");
  });

  it("infra: docs/deploys.md 한 줄 (버전은 앞 8자리)", () => {
    expect(
      deployLogLine({
        at: Date.UTC(2026, 9, 6, 0, 24),
        version: NEW_VERSION,
        commit: "3a4cc93",
        migrations: ["0003_meta.sql", "0005_list_json.sql"],
        result: "성공",
        previous: PREV_VERSION,
      }),
    ).toBe("| 2026-10-06 09:24 | 72a9f970 | 3a4cc93 | 0003_meta, 0005_list_json | 성공 | 2f5adde0 |");
    expect(deployLogLine({ at: Date.UTC(2026, 9, 6, 0, 24), version: null, commit: "3a4cc93", migrations: [], result: "배포 전 중단", previous: null })).toBe(
      "| 2026-10-06 09:24 | - | 3a4cc93 | - | 배포 전 중단 | - |",
    );
    // 마이그레이션 칸 메모(적용 실패)
    expect(
      deployLogLine({ at: Date.UTC(2026, 9, 6, 0, 24), version: null, commit: "3a4cc93", migrations: ["0005_list_json.sql"], migrationsNote: "적용 실패", result: "배포 전 중단", previous: null }),
    ).toBe("| 2026-10-06 09:24 | - | 3a4cc93 | 0005_list_json (적용 실패) | 배포 전 중단 | - |");
  });
});
