import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_RADIUS } from "../../shared/constants";
import { tileKeyOf, tilesCoveringCircle } from "../../shared/geo";
import { hubById } from "../../shared/hubs";
import { createApp } from "../../worker/app";
import worker from "../../worker/index";
import { ReadOnlyViolation, isReadOnly, logReadOnlyOnce, readOnlyDb, readOnlyEnv, resetReadOnlyNoticeForTest, writeKeyword } from "../../worker/readOnly";
import { fakeKakaoLocal, fakePlaceApi, routeFetch } from "../helpers/fakeKakao";
import { placeJson, seedPlace } from "../helpers/places";

/** 개발 서버(vite dev)에서만 주는 값 — 운영 설정(wrangler.jsonc vars)에는 없다 */
const RO_ENV = { ...env, READ_ONLY: "1" } as Env;
const AUTH = { Authorization: "Bearer test-admin-token" };
const HUB = hubById("bongeunsa");
const HUB_CENTER = { lat: HUB.lat, lng: HUB.lng };

describe("R52: 쓰기 문장 분류 (writeKeyword)", () => {
  it.each([
    ["SELECT 1"],
    ["select * from places where id = ?"],
    ["  \n\t SELECT 1"],
    ["-- 주석\nSELECT 1"],
    ["/* INSERT */ SELECT 1"],
    ["/* a */ -- b\n /* c */ select 1"],
    ["SELECT 'INSERT INTO x; DELETE FROM y' AS s"],
    ['SELECT "update", [delete], `drop` FROM t'],
    ["SELECT 1;"],
    ["SELECT 1; SELECT 2"],
    ["VALUES (1), (2)"],
    ["EXPLAIN QUERY PLAN SELECT * FROM places"],
    ["WITH t AS (SELECT 1 AS n) SELECT n FROM t"],
    ["with t(n) as (select ')' ) select n from t"],
    ["WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r"],
    ["WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT * FROM a, b"],
    ["PRAGMA table_info(places)"],
    ["pragma main.index_list('places')"],
    ["PRAGMA foreign_keys"],
    [""],
    ["  -- 주석만\n"],
  ])("읽기: %j", (sql) => {
    expect(writeKeyword(sql)).toBeNull();
  });

  it.each([
    ["INSERT INTO meta (key, value) VALUES (?, ?)", "INSERT"],
    ["insert into meta (key, value) values (?, ?)", "INSERT"],
    ["INSERT OR IGNORE INTO tile_places (tile_key, place_id) SELECT ?, value FROM json_each(?)", "INSERT"],
    ["INSERT OR REPLACE INTO places (id) VALUES (?)", "INSERT"],
    [
      "INSERT INTO meta (key, value) SELECT ?, '1' WHERE true ON CONFLICT(key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1 RETURNING value",
      "INSERT",
    ],
    ["REPLACE INTO meta (key, value) VALUES (?, ?)", "REPLACE"],
    ["UPDATE places SET list_json = NULL", "UPDATE"],
    ["update places set name = 'select'", "UPDATE"],
    ["DELETE FROM meta WHERE key LIKE ?", "DELETE"],
    ["-- 주석\n/* SELECT */ DELETE FROM events", "DELETE"],
    ["CREATE TABLE x (a)", "CREATE"],
    ["create index if not exists i on places(id)", "CREATE"],
    ["DROP TABLE places", "DROP"],
    ["ALTER TABLE places ADD COLUMN x TEXT", "ALTER"],
    ["VACUUM", "VACUUM"],
    ["PRAGMA foreign_keys = OFF", "PRAGMA"],
    ["pragma user_version=3", "PRAGMA"],
    ["PRAGMA journal_mode(WAL)", "PRAGMA"],
    ["PRAGMA optimize", "PRAGMA"],
    ["WITH x AS (SELECT 1 AS n) INSERT INTO t SELECT n FROM x", "INSERT"],
    ["with x as (select ')' as p) delete from t where p in (select p from x)", "DELETE"],
    ["WITH x AS (SELECT 1) UPDATE t SET a = (SELECT * FROM x)", "UPDATE"],
    ["SELECT 1; DELETE FROM meta", "DELETE"],
    ["ANALYZE", "ANALYZE"],
    ["REINDEX places", "REINDEX"],
  ])("쓰기: %j → %s", (sql, keyword) => {
    expect(writeKeyword(sql)).toBe(keyword);
  });
});

describe("R52: 읽기 전용 D1 (readOnlyDb)", () => {
  it("R52: 쓰기 문장은 prepare에서 막고(실행 전), SELECT는 그대로 실행한다", async () => {
    const db = readOnlyDb(env.DB);
    expect(() => db.prepare("INSERT INTO meta (key, value) VALUES ('a', '1')")).toThrow(ReadOnlyViolation);
    expect(() => db.prepare("insert into meta (key, value) values ('a', '1')")).toThrow(/INSERT/);
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('a', '1')").run();
    expect(await db.prepare("SELECT value FROM meta WHERE key = ?").bind("a").first("value")).toBe("1");
    expect(await db.prepare("SELECT value FROM meta WHERE key = ?").bind("a").first()).toEqual({ value: "1" });
    expect((await db.prepare("SELECT key FROM meta").all()).results).toEqual([{ key: "a" }]);
    expect(await db.prepare("SELECT key FROM meta").raw()).toEqual([["a"]]);
    expect((await db.prepare("SELECT 1").run()).success).toBe(true);
  });

  it("R52: batch는 이 감싸개로 준비한 읽기 문장만 받고, exec도 쓰기를 막는다", async () => {
    const db = readOnlyDb(env.DB);
    const rs = await db.batch([db.prepare("SELECT 1 AS n"), db.prepare("SELECT ? AS n").bind(2)]);
    expect(rs.map((r) => r.results)).toEqual([[{ n: 1 }], [{ n: 2 }]]);
    // 감싸지 않은 D1에서 준비한 문장은 SQL을 확인할 수 없으므로 받지 않는다
    await expect(db.batch([env.DB.prepare("DELETE FROM meta")])).rejects.toThrow(ReadOnlyViolation);
    await expect(db.exec("DELETE FROM meta")).rejects.toThrow(ReadOnlyViolation);
    expect(() => db.withSession().prepare("UPDATE meta SET value = '2'")).toThrow(ReadOnlyViolation);
  });

  it("R52: exec는 항상 막는다 — D1 exec는 줄바꿈으로 문장을 나누므로 SQL 분류를 믿을 수 없고, 앱은 exec를 쓰지 않는다", async () => {
    const db = readOnlyDb(env.DB);
    // 줄바꿈으로 이어 붙인 쓰기 (분류기는 한 문장으로 읽지만 D1은 줄마다 실행한다)
    await expect(db.exec("SELECT 1\nDELETE FROM meta")).rejects.toThrow(ReadOnlyViolation);
    await expect(db.exec("INSERT INTO meta (key, value) VALUES ('a', '1')\nINSERT INTO meta (key, value) VALUES ('b', '2')")).rejects.toThrow(ReadOnlyViolation);
    // 읽기만 있어도 막는다
    await expect(db.exec("SELECT 1")).rejects.toThrow(ReadOnlyViolation);
    expect((await env.DB.prepare("SELECT key FROM meta").all()).results).toEqual([]);
  });

  it("R52: READ_ONLY가 \"1\"일 때만 Worker 입구에서 DB를 감싼다", () => {
    expect(readOnlyEnv(env)).toBe(env);
    expect(readOnlyEnv({ ...env, READ_ONLY: "0" } as Env).DB).toBe(env.DB);
    const ro = readOnlyEnv(RO_ENV);
    expect(ro.DB).not.toBe(env.DB);
    expect(() => ro.DB.prepare("DELETE FROM meta")).toThrow(ReadOnlyViolation);
  });

  it.each([["1", true], ["true", true], ["yes", true], ["on", true], ["TRUE", true], ["2", true], [" 1 ", true], ["0", false], ["false", false], ["FALSE", false], [" 0 ", false], ["", false], ["  ", false], [undefined, false]])(
    "R52: READ_ONLY=%j 이면 읽기 전용 %s (비어 있지 않고 0·false가 아니면 켠다 — 실패하면 닫힌다)",
    (value, expected) => {
      const e = { ...env, READ_ONLY: value } as Env;
      expect(isReadOnly(e)).toBe(expected);
      expect(readOnlyEnv(e).DB === env.DB).toBe(!expected);
    },
  );

  it("R52: 운영 설정(wrangler.jsonc vars)에는 READ_ONLY가 없다", () => {
    expect((env as unknown as Record<string, unknown>).READ_ONLY).toBeUndefined();
  });
});

describe("R52: 읽기 전용 알림 (격리 하나에 한 번)", () => {
  afterEach(() => resetReadOnlyNoticeForTest());

  it("R52: READ_ONLY가 켜져 있으면 첫 요청에서만 한 줄 남기고, 꺼져 있으면 남기지 않는다", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      resetReadOnlyNoticeForTest();
      logReadOnlyOnce(env);
      expect(log).not.toHaveBeenCalled();
      logReadOnlyOnce(RO_ENV);
      logReadOnlyOnce(RO_ENV);
      expect(log.mock.calls).toEqual([["[read-only] 운영 D1 읽기 전용 모드"]]);
    } finally {
      log.mockRestore();
    }
  });

  it("R52: Worker 입구의 첫 fetch가 알림을 남긴다", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      resetReadOnlyNoticeForTest();
      const ctx = createExecutionContext();
      const req = new Request("http://localhost/api/places?hub=gwacheon&radius=1000") as Parameters<typeof worker.fetch>[0];
      await worker.fetch(req, RO_ENV, ctx);
      await worker.fetch(req, RO_ENV, ctx);
      await waitOnExecutionContext(ctx);
      expect(log.mock.calls.filter((c) => c[0] === "[read-only] 운영 D1 읽기 전용 모드")).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });
});

describe("R52: Worker 입구가 DB를 실제로 감싼다 (스파이 D1)", () => {
  it("R52: READ_ONLY=1로 worker.fetch를 거친 목록 요청이 안쪽 D1에 넘긴 SQL은 모두 읽기다", async () => {
    const seen: string[] = [];
    // 호출 스택에 readOnly 감싸개가 있는지 — 입구가 DB를 감싸지 않았다면 앱이 스파이를 직접 부른다 (앱은 쓰기를 먼저 건너뛰므로 SQL만으로는 알 수 없다)
    const viaWrapper: boolean[] = [];
    const spy = {
      prepare: (sql: string) => {
        seen.push(sql);
        viaWrapper.push(/worker\/readOnly\.ts/.test(new Error().stack ?? ""));
        return env.DB.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => env.DB.batch(stmts),
      exec: (sql: string) => {
        seen.push(sql);
        return env.DB.exec(sql);
      },
      withSession: (c?: string) => env.DB.withSession(c),
      dump: () => env.DB.dump(),
    } as unknown as D1Database;
    const hub = hubById("gwacheon");
    await seedPlace(env.DB, "1001", hub.lat + 0.0005, hub.lng, { now: Date.now() });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("테스트에서 외부 호출 없음");
    });
    try {
      const ctx = createExecutionContext();
      const req = new Request("http://localhost/api/places?hub=gwacheon&radius=1000") as Parameters<typeof worker.fetch>[0];
      const res = await worker.fetch(req, { ...env, READ_ONLY: "1", DB: spy } as Env, ctx);
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
    } finally {
      fetchSpy.mockRestore();
    }
    // 스파이가 실제로 쓰였는지 (감싸개를 건너뛰고 env.DB를 직접 썼다면 비어 있다)
    expect(seen.length).toBeGreaterThan(0);
    expect(viaWrapper.every(Boolean)).toBe(true);
    expect(seen.filter((sql) => writeKeyword(sql) !== null)).toEqual([]);
  });
});

const TABLES = ["places", "tiles", "tile_places", "meta", "events"];
/** 쓰기가 하나도 없었는지 확인하려고 표 전체를 찍어 둔다 (행 수뿐 아니라 값까지) */
const snapshot = async () =>
  Object.fromEntries(
    await Promise.all(TABLES.map(async (t) => [t, (await env.DB.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results])),
  );

async function callEntry(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(`http://localhost${path}`, init) as Parameters<typeof worker.fetch>[0];
  const res = await worker.fetch(req, RO_ENV, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("R52: READ_ONLY=1 (개발 서버가 운영 D1에 붙을 때)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("테스트에서 외부 호출 없음");
    });
  });
  afterEach(() => fetchSpy.mockRestore());

  it("R52: 목록은 저장된 데이터로 그대로 답하고, 격자 수집·상세 보충·사용량 기록을 하지 않는다 (D1 쓰기 0)", async () => {
    const now = Date.now();
    const keys = tilesCoveringCircle(HUB_CENTER, MAX_RADIUS);
    const here = tileKeyOf(HUB_CENTER);
    // 격자 하나는 만료(수집 대상), 나머지는 방금 수집
    await env.DB.batch(
      keys.map((k) =>
        env.DB.prepare("INSERT INTO tiles (key, collected_at, place_count, saturated) VALUES (?, ?, 0, 0)").bind(k, k === keys[0] ? 0 : now),
      ),
    );
    await seedPlace(env.DB, "1001", HUB.lat + 0.0005, HUB.lng, { now });
    // 1002는 격자에만 있고 상세가 없다 (보통 모드라면 waitUntil로 보충한다)
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tile_places (tile_key, place_id) VALUES (?, '1001')").bind(tileKeyOf({ lat: HUB.lat + 0.0005, lng: HUB.lng })),
      env.DB.prepare("INSERT INTO tile_places (tile_key, place_id) VALUES (?, '1002')").bind(here),
    ]);
    const before = await snapshot();

    const res = await callEntry("/api/places?hub=bongeunsa&radius=1000");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { places: { id: string }[]; pending: number; incompleteTiles: number; detailsPaused: boolean };
    expect(body.places.map((p) => p.id)).toEqual(["1001"]);
    expect(body.pending).toBe(1);
    // 수집·보충을 할 수 없으니 화면이 기다리며 다시 부르지 않게 한다 (web/pollSchedule.ts)
    expect(body.incompleteTiles).toBe(0);
    expect(body.detailsPaused).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("R52: 상세는 저장된 행을 그대로 주고, 저장되지 않은 id는 보여주기만 하고 성공·실패 모두 저장하지 않는다", async () => {
    const NOW = 1_800_000_000_000;
    const lat = HUB.lat + 0.0002;
    await seedPlace(env.DB, "1001", lat, HUB.lng, { now: NOW });
    await env.DB.batch(
      ["5555", "7777"].map((id) => env.DB.prepare("INSERT INTO tile_places (tile_key, place_id) VALUES (?, ?)").bind(tileKeyOf({ lat, lng: HUB.lng }), id)),
    );
    const place = fakePlaceApi({ "5555": placeJson({ name: "가게5555", lat, lng: HUB.lng }), "7777": 404 });
    const app = createApp({
      fetcher: routeFetch(fakeKakaoLocal([]).fetcher, place.fetcher),
      now: () => NOW,
      sleep: async () => {},
      rateLimit: async () => true,
    });
    const call = async (path: string) => {
      const ctx = createExecutionContext();
      const res = await app.fetch(new Request(`http://localhost${path}`), readOnlyEnv(RO_ENV), ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    const before = await snapshot();

    const stored = await call("/api/places/1001");
    expect(stored.status).toBe(200);
    expect(((await stored.json()) as { name: string }).name).toBe("가게1001");
    const shown = await call("/api/places/5555");
    expect(shown.status).toBe(200);
    expect(((await shown.json()) as { name: string }).name).toBe("가게5555");
    expect((await call("/api/places/7777")).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it("R52: /api/events는 아무것도 저장하지 않고 204", async () => {
    const before = await snapshot();
    const res = await callEntry("/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anon: "0b0e7c6e-3f6b-4b8e-9a3e-1c2d3e4f5a6b",
        session: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        events: [{ t: "draw", ts: Date.now(), hub: "bongeunsa" }],
      }),
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["/api/admin/warm?lat=37.5&lng=127.05&radius=300"],
    ["/api/admin/warm"],
    ["/api/admin/backfill"],
    ["/api/admin/backfill?hub=bongeunsa&limit=10"],
  ])("R52: 관리자 쓰기 %s는 403 read_only", async (path) => {
    const before = await snapshot();
    const res = await callEntry(path, { method: "POST", headers: AUTH });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "read_only" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it("R52: 관리자 쓰기도 토큰이 없으면 먼저 401", async () => {
    expect((await callEntry("/api/admin/warm", { method: "POST" })).status).toBe(401);
  });

  it("R52: Cron(scheduled)은 로그 한 줄만 남기고 아무것도 하지 않는다", async () => {
    const before = await snapshot();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: "*/5 * * * *" }), RO_ENV, ctx);
      await waitOnExecutionContext(ctx);
      expect(log.mock.calls).toEqual([[expect.stringContaining("READ_ONLY")]]);
    } finally {
      log.mockRestore();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });
});
