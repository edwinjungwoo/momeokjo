// Task 34: 상세 보충(enrichment) 한 번이 로컬 workerd(Miniflare)에서 쓰는 시간을 잰다 — 무료 플랜 CPU 10ms 확인용.
// 배포하지 않는 측정 도구다. 카카오를 부르지 않는다: Worker 안의 가짜 fetcher가 실제 상세 픽스처(test/fixtures/place-detail,
// 압축 없는 한 줄 JSON 50~97KB)를 좌표만 거점 근처로 바꿔 돌려준다. D1은 Miniflare 로컬 SQLite다 (운영 D1에 붙지 않는다).
// 측정값은 벽시계(ms)라 D1 SQLite 시간이 들어 있다 — 운영 CPU보다 크게 나오는 쪽이다 (D1 질의는 운영에서 Worker CPU가 아니다).
//   warm: POST /api/admin/warm (강남역 1000m, 격자는 모두 수집됨, 미수집 PENDING곳) — 2026-10-06 사고와 같은 경로
//   cron: 본 Cron 한 번 (runScheduled: 모든 거점, 만료·미수집 후보, 보충)
//   warm, new isolate: Worker를 다시 올린 뒤(새 isolate, JIT가 데워지지 않음) 첫 warm과 두 번째 warm
//   parts: 한 번의 보충을 나눈 조각. 같은 일을 1번·11번 하는 요청의 차이 / 10 = 한 번 (요청 바닥값이 빠진다).
//     가짜 fetcher의 text·json 조각에는 JS 문자열을 UTF-8로 바꾸는 시간이 들어 있다 (운영 응답에는 없고, 대신 압축 풀기가 있다)
// 실행: node scripts/bench-enrich.mjs [미수집 곳 수=1300] [반복=20]
//   BENCH_ROOT=<다른 체크아웃>이면 그 코드로 잰다 (전/후 비교: git worktree add --detach <폴더> <커밋> 뒤 node_modules 링크.
//     앞 코드에 없는 조각은 건너뛴다)
//   BENCH_CHAR_BUDGET=<글자 수>면 DETAIL_CHAR_BUDGET 변수로 넘긴다. BENCH_PAYLOAD=max면 모든 상세가 가장 큰 픽스처다 (최악)
//   BENCH_PARTS=a,b로 조각을 고른다(빈 값이면 조각을 건너뛴다). BENCH_COLD=<횟수>는 새 isolate 측정 횟수 (0이면 건너뛴다)
// 의존성: miniflare·esbuild는 wrangler·vite가 설치한 것(node_modules 최상위)을 쓴다. 없으면 `npm i --no-save miniflare esbuild`.
import { build as esbuild } from "esbuild";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

const root = process.env.BENCH_ROOT ?? join(import.meta.dirname, "..");
const PENDING = Number(process.argv[2] ?? 1300);
const RUNS = Number(process.argv[3] ?? 20);
/** 강남역에 이미 상세가 있는 곳 (사고 때 ~120번 × 10곳) */
const DONE = 1200;
/** 나머지 거점마다 상세가 있는 곳 (fetched_at을 지난 4일에 흩뿌려 일부는 만료) */
const OTHER_OK = 2000;
const NOW = Date.now();

const bundle = async (contents) =>
  (
    await esbuild({
      stdin: { contents, resolveDir: root, loader: "ts" },
      bundle: true, write: false, format: "esm", platform: "neutral", mainFields: ["module", "main"],
      external: ["cloudflare:*"], logLevel: "error", // 앞 코드에 없는 export(Task 34 조각)는 undefined — 경고를 숨긴다
    })
  ).outputFiles[0].text;

const helpers = await bundle(`export { parseDetail } from "./worker/detailParser";
  export { storedListJson } from "./worker/present";
  export { detailRow } from "./worker/repo";
  export { categoryGroup } from "./shared/category";
  export { HUBS } from "./shared/hubs";
  export { tileKeyOf, tileRect, boundingBox, tilesCoveringCircle } from "./shared/geo";`);
const mod = await import(`data:text/javascript;base64,${Buffer.from(helpers).toString("base64")}`);
const GANGNAM = mod.HUBS.find((h) => h.id === "gangnam");
if (!GANGNAM) throw new Error("gangnam 거점이 없는 코드예요 (141bca4 이후에서 실행)");

// 픽스처를 압축 없는 한 줄 JSON으로 (운영 응답과 같은 모양). 좌표는 강남역 근처로 바꾼다 (스냅샷 표시가 실제처럼 강남에 걸리게)
const fixtureDir = join(root, "test/fixtures/place-detail");
const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(fixtureDir, f), "utf8")));
const payloads = fixtures.map((o, k) =>
  JSON.stringify({ ...o, summary: { ...o.summary, point: { lat: GANGNAM.lat + (k - 6) * 0.0004, lon: GANGNAM.lng + (k - 6) * 0.0005 } } }),
);
if (process.env.BENCH_PAYLOAD === "max") {
  const big = payloads.reduce((a, b) => (b.length > a.length ? b : a));
  payloads.fill(big);
}
const payloadBytes = payloads.map((p) => Buffer.byteLength(p));

const worker = await bundle(`import { createApp } from "./worker/app";
  import { parseDetail } from "./worker/detailParser";
  import { fetchPlaceDetail } from "./worker/kakaoPlace";
  import { Budget } from "./worker/budget";
  import { runScheduled } from "./worker/maintenance";
  import * as repo from "./worker/repo";
  const { detailGate, expiredDetailStates, getTiles, pickDetailIds, saveDetail, tilePlaceStates, unfetchedStates } = repo;
  import { HUBS } from "./shared/hubs";
  import { tilesCoveringCircle } from "./shared/geo";
  const PAYLOADS = ${JSON.stringify(payloads)};
  const pick = (id) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return PAYLOADS[h % PAYLOADS.length]; };
  const fetcher = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("dapi.kakao.com")) return new Response("{}", { status: 500 });
    return new Response(pick(url.split("/").pop()), { headers: { "content-type": "application/json" } });
  };
  const app = createApp({ fetcher, rateLimit: async () => true, adminRateLimit: async () => true, sleep: async () => {} });
  const GANGNAM = HUBS.find((h) => h.id === "gangnam");
  const GKEYS = tilesCoveringCircle(GANGNAM, 1000);
  const ALLKEYS = [...new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, 1000)))];
  const ids10 = Array.from({ length: 10 }, (_, k) => "bench" + k);
  const parts = {
    async text(n) { for (let r = 0; r < n; r++) for (const id of ids10) await new Response(pick(id)).text(); },
    async json(n) { for (let r = 0; r < n; r++) for (const id of ids10) await new Response(pick(id)).json(); },
    async parseDetail(n) {
      const objs = ids10.map((id) => JSON.parse(pick(id)));
      for (let r = 0; r < n; r++) for (const o of objs) parseDetail(o);
    },
    async fetchDetail(n) {
      for (let r = 0; r < n; r++) for (const id of ids10) await fetchPlaceDetail(fetcher, id, { budget: new Budget(5) });
    },
    async saveDetail(n, env) {
      const parsed = ids10.map((id) => parseDetail(JSON.parse(pick(id))));
      for (let r = 0; r < n; r++) for (let k = 0; k < 10; k++) await saveDetail(env.DB, "9" + k, parsed[k].summary, parsed[k].detail, Date.now());
    },
    async gate(n, env) { for (let r = 0; r < n; r++) await detailGate(env.DB); },
    async tiles(n, env) { for (let r = 0; r < n; r++) await getTiles(env.DB, GKEYS); },
    async states(n, env) { for (let r = 0; r < n; r++) await tilePlaceStates(env.DB, GKEYS); },
    async pick(n, env) {
      const s = await tilePlaceStates(env.DB, GKEYS);
      for (let r = 0; r < n; r++) pickDetailIds(s, GANGNAM, Date.now(), 10, "due");
    },
    async cronTiles(n, env) { for (let r = 0; r < n; r++) await getTiles(env.DB, ALLKEYS); },
    async cronUnfetched(n, env) { for (let r = 0; r < n; r++) await unfetchedStates(env.DB, ALLKEYS); },
    // Task 34 뒤의 길 (앞 코드에는 없어서 건너뛴다)
    saveDetails: repo.saveDetails && (async (n, env) => {
      const parsed = ids10.map((id, k) => ({ id: "9" + k, ...parseDetail(JSON.parse(pick(id))) }));
      for (let r = 0; r < n; r++) await repo.saveDetails(env.DB, parsed.map((x) => ({ id: x.id, summary: x.summary, detail: x.detail })), Date.now());
    }),
    nearest: repo.nearestUnfetchedStates && (async (n, env) => { for (let r = 0; r < n; r++) await repo.idsNeedingDetail(env.DB, GANGNAM, 1000, Date.now(), 10); }),
    dueTiles: repo.dueTileKeys && (async (n, env) => { for (let r = 0; r < n; r++) await repo.dueTileKeys(env.DB, GKEYS, Date.now()); }),
    cronDueTiles: repo.dueTileKeys && (async (n, env) => { for (let r = 0; r < n; r++) await repo.dueTileKeys(env.DB, ALLKEYS, Date.now()); }),
    cronNearest: repo.nearestUnfetchedStates && (async (n, env) => { for (let r = 0; r < n; r++) await repo.nearestUnfetchedStates(env.DB, ALLKEYS, HUBS, 10); }),
    async cronExpired(n, env) { for (let r = 0; r < n; r++) await expiredDetailStates(env.DB, ALLKEYS, Date.now()); },
    async cronPick(n, env) {
      const c = [...(await expiredDetailStates(env.DB, ALLKEYS, Date.now())), ...(await unfetchedStates(env.DB, ALLKEYS))];
      for (let r = 0; r < n; r++) pickDetailIds(c, HUBS, Date.now(), 10, "due");
    },
  };
  export default {
    async fetch(req, env, ctx) {
      const u = new URL(req.url);
      if (u.pathname === "/__bench/part") {
        const part = parts[u.searchParams.get("name")];
        if (!part) return new Response("missing", { status: 404 });
        await part(Number(u.searchParams.get("n")), env);
        return new Response("ok");
      }
      if (u.pathname === "/__bench/cron") return Response.json(await runScheduled(env, { fetcher, now: Date.now(), sleep: async () => {} }));
      if (u.pathname === "/__bench/pending") {
        const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM tile_places tp WHERE tp.tile_key IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM places p WHERE p.id = tp.place_id)").bind(JSON.stringify(GKEYS)).first();
        return Response.json(r);
      }
      return app.fetch(req, env, ctx);
    },
  };`);

const text = (value) => ({ type: "text", value });
// D1을 임시 폴더에 둔다 — cold 측정이 Worker를 다시 올려도(새 isolate) 데이터가 남게
const persist = mkdtempSync(join(tmpdir(), "bench-enrich-"));
const options = (variant) => ({
  resourcePersistencePath: persist,
  workers: [{
    config: {
      name: "bench-enrich",
      compatibilityDate: "2026-08-01",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: `${worker}\n// ${variant}` } } },
      env: {
        DB: { type: "d1", id: "bench-enrich" },
        KAKAO_REST_KEY: text("x"), ADMIN_TOKEN: text("bench"), SUBREQUEST_BUDGET: text("40"), DETAIL_BATCH_SIZE: text("10"),
        ...(process.env.BENCH_CHAR_BUDGET ? { DETAIL_CHAR_BUDGET: text(process.env.BENCH_CHAR_BUDGET) } : {}),
      },
    },
  }],
});
const mf = new Miniflare(options(0));
const db = await mf.getD1Database("DB");
for (const f of readdirSync(join(root, "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  const sql = readFileSync(join(root, "migrations", f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
}

// 데이터: 모든 거점의 격자는 방금 수집됨. 강남은 DONE곳 상세 있음 + PENDING곳 미수집, 다른 거점은 OTHER_OK곳 상세 있음(일부 만료)
const parsed = fixtures.map((o) => mod.parseDetail(o)).filter((r) => r.ok);
let seed = 7;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x1_0000_0000);
const placeRows = [];
const tileRows = [];
let serial = 0;
for (const hub of mod.HUBS) {
  const keys = mod.tilesCoveringCircle(hub, 1000);
  const ok = hub.id === "gangnam" ? DONE : ["yeouido", "gwanghwamun"].includes(hub.id) ? 0 : OTHER_OK;
  const pending = hub.id === "gangnam" ? PENDING : 0;
  for (let i = 0; i < ok + pending; i++) {
    const key = keys[Math.floor(rand() * keys.length)];
    const r = mod.tileRect(key);
    const lat = r.minLat + rand() * (r.maxLat - r.minLat);
    const lng = r.minLng + rand() * (r.maxLng - r.minLng);
    const id = String(100000000 + serial++ * 7919);
    tileRows.push([key, id]);
    if (i >= ok) continue;
    const { summary: s, detail: d } = parsed[i % parsed.length];
    const fetchedAt = NOW - Math.floor(rand() * 4 * 24 * 3600_000);
    placeRows.push([
      id, s.name, s.categoryName, mod.categoryGroup(s.categoryName), lat, lng, s.address, s.phone, s.photoUrl, d.rating,
      d.reviewCount, d.price, JSON.stringify(d.menus), d.hours ? JSON.stringify(d.hours) : null, JSON.stringify(d.strengths),
      JSON.stringify(d.tags), d.bookable === null ? null : d.bookable ? 1 : 0, fetchedAt,
      mod.storedListJson(mod.detailRow(id, { ...s, lat, lng }, d, fetchedAt)),
    ]);
  }
  for (const k of keys) {
    await db.prepare("INSERT OR REPLACE INTO tiles (key, collected_at, place_count, saturated) VALUES (?, ?, 0, 0)").bind(k, NOW).run();
  }
}
const cols = ["id", "name", "category_name", "category_group", "lat", "lng", "address", "phone", "photo_url", "rating",
  "review_count", "price", "menus_json", "hours_json", "strengths_json", "tags_json", "bookable", "fetched_at", "list_json"];
for (let i = 0; i < placeRows.length; i += 200) {
  await db
    .prepare(`INSERT INTO places (status, ${cols.join(", ")}) SELECT 'ok', ${cols.map((_, k) => `json_extract(value, '$[${k}]')`).join(", ")} FROM json_each(?)`)
    .bind(JSON.stringify(placeRows.slice(i, i + 200)))
    .run();
}
for (let i = 0; i < tileRows.length; i += 500) {
  await db.prepare("INSERT OR IGNORE INTO tile_places (tile_key, place_id) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?)")
    .bind(JSON.stringify(tileRows.slice(i, i + 500))).run();
}
// 운영처럼: list_json 백필은 끝났고, 격자가 바뀐 뒤 미수집 확인은 아직이다
await db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('list_json_backfill:v1', 'done'), ('tiles_changed_at', ?)").bind(String(NOW)).run();

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (x) => Number(x.toFixed(2));
const wall = async (url, init) => {
  const t0 = performance.now();
  const res = await mf.dispatchFetch(url, init);
  const body = await res.text();
  return { ms: performance.now() - t0, status: res.status, body };
};
const pendingNow = async () => (await (await mf.dispatchFetch("http://localhost/__bench/pending")).json()).n;

console.log(JSON.stringify({
  root, pendingGangnam: PENDING, doneGangnam: DONE, otherHubOk: OTHER_OK, runs: RUNS,
  charBudget: process.env.BENCH_CHAR_BUDGET ?? "default", payloadChars: { mean: Math.round(payloads.reduce((a, b) => a + b.length, 0) / payloads.length), max: Math.max(...payloads.map((p) => p.length)) },
  payloadKB: { min: round(Math.min(...payloadBytes) / 1024), max: round(Math.max(...payloadBytes) / 1024), mean: round(payloadBytes.reduce((a, b) => a + b, 0) / payloadBytes.length / 1024) },
}));

// 요청 바닥값
{
  const xs = [];
  for (let i = 0; i < RUNS; i++) xs.push((await wall("http://localhost/api/health")).ms);
  console.log(JSON.stringify({ path: "health (baseline)", wallMedianMs: round(median(xs)) }));
}

// 조각: (11번 − 1번) / 10, 7번의 중앙값
const PARTS = (process.env.BENCH_PARTS ??
  "text,json,parseDetail,fetchDetail,saveDetail,saveDetails,gate,tiles,dueTiles,states,pick,nearest,cronTiles,cronDueTiles,cronUnfetched,cronNearest,cronExpired,cronPick")
  .split(",").filter(Boolean);
for (const name of PARTS) {
  const run = async (n) => {
    const r = await wall(`http://localhost/__bench/part?name=${name}&n=${n}`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`${name}: ${r.status} ${r.body.slice(0, 300)}`);
    return r.ms;
  };
  if ((await run(1)) === null) {
    console.log(JSON.stringify({ part: name, skipped: "not in this code" }));
    continue;
  }
  await run(3);
  const one = [];
  const eleven = [];
  for (let i = 0; i < 7; i++) {
    one.push(await run(1));
    eleven.push(await run(11));
  }
  const ms = (median(eleven) - median(one)) / 10;
  console.log(JSON.stringify({ part: name, wallMs: round(ms) }));
}

// 한 번의 warm (상세 10곳). 응답이 enriched=10인지 확인한다
{
  const url = `http://localhost/api/admin/warm?lat=${GANGNAM.lat}&lng=${GANGNAM.lng}&radius=1000`;
  const init = { method: "POST", headers: { authorization: "Bearer bench" } };
  for (let i = 0; i < 3; i++) await wall(url, init);
  const xs = [];
  const placesDone = [];
  let last = null;
  for (let i = 0; i < RUNS; i++) {
    const r = await wall(url, init);
    if (r.status !== 200) throw new Error(`warm ${r.status} ${r.body}`);
    last = JSON.parse(r.body);
    xs.push(r.ms);
    placesDone.push(last.enriched + last.failed);
  }
  console.log(JSON.stringify({ path: "warm gangnam", wallMedianMs: round(median(xs)), min: round(Math.min(...xs)), placesMedian: median(placesDone), last, pendingLeft: await pendingNow() }));
}

// 본 Cron 한 번
{
  const xs = [];
  const placesDone = [];
  let last = null;
  const reads = [];
  // Cron은 실행마다 이번 실행이 읽은 행 수를 meta d1_read:{UTC 날}에 더한다
  const readsSoFar = async () =>
    Number((await db.prepare("SELECT COALESCE(SUM(CAST(value AS INTEGER)), 0) AS n FROM meta WHERE key LIKE 'd1_read:%'").first())?.n ?? 0);
  for (let i = 0; i < Math.max(5, RUNS); i++) {
    const before = await readsSoFar();
    const r = await wall("http://localhost/__bench/cron");
    if (r.status !== 200) throw new Error(`cron ${r.status} ${r.body}`);
    last = JSON.parse(r.body);
    xs.push(r.ms);
    placesDone.push(last.enriched + last.failed);
    reads.push((await readsSoFar()) - before);
  }
  console.log(JSON.stringify({ path: "cron", wallMedianMs: round(median(xs)), min: round(Math.min(...xs)), placesMedian: median(placesDone), rowsReadMedian: median(reads), last, pendingLeft: await pendingNow() }));
}
// 새 isolate의 첫 warm (JIT가 데워지지 않은 상태 — 운영 isolate는 자주 바뀐다). 앞에 health 한 번으로 앱 초기화는 뺀다
{
  const url = `http://localhost/api/admin/warm?lat=${GANGNAM.lat}&lng=${GANGNAM.lng}&radius=1000`;
  const init = { method: "POST", headers: { authorization: "Bearer bench" } };
  const first = [];
  const second = [];
  const coldRuns = Number(process.env.BENCH_COLD ?? 7);
  for (let i = 1; i <= coldRuns; i++) {
    await mf.setOptions(options(i));
    await wall("http://localhost/api/health");
    first.push((await wall(url, init)).ms);
    second.push((await wall(url, init)).ms);
  }
  if (coldRuns > 0) console.log(JSON.stringify({ path: "warm gangnam, new isolate", firstMedianMs: round(median(first)), secondMedianMs: round(median(second)), first: first.map(round) }));
}
await mf.dispose();
rmSync(persist, { recursive: true, force: true });
