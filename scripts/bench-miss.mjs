// Task 31: 목록 엣지 캐시 미스 한 번이 로컬 workerd(Miniflare)에서 걸리는 시간과 D1 읽기 행 수를 잰다.
// 배포하지 않는 측정 도구다. bench-places.mjs(Node, 가짜 D1)는 workerd의 D1 결과 해석·문자열 만들기·응답 인코딩을 빼고 재서
// 운영(동대문 미스 CPU 37ms)과 크게 달랐다 — 여기서는 실제 Worker 코드를 esbuild로 묶어 Miniflare(workerd + 로컬 SQLite D1)에서
// 그대로 부른다. 측정값은 벽시계(ms)라 CPU만은 아니지만(D1 SQLite 시간 포함) 두 길을 같은 조건에서 비교한다.
//   live: GET /api/places?hub=ddp — 지금의 미스 경로 (격자·격자-장소·목록 조회 → 본문 이어 붙이기)
//   snapshot: 같은 요청을 거점 스냅샷 한 행으로 답하는 경로 (worker/hubSnapshot.ts가 있을 때만)
//   build: Cron이 스냅샷 한 거점을 만드는 시간 (목록 조회 + 본문 + gzip + 저장)
// 실행: node scripts/bench-miss.mjs [곳 수=2000] [반복=20]
// 의존성: miniflare·esbuild는 wrangler·vite가 설치한 것(node_modules 최상위)을 쓴다 — package.json에 따로 두지 않았다.
//   없으면 `npm i --no-save miniflare esbuild`. 운영 D1에는 붙지 않는다 (Miniflare 로컬 D1만).
import { build as esbuild } from "esbuild";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";

const root = join(import.meta.dirname, "..");
const N = Number(process.argv[2] ?? 2000);
const RUNS = Number(process.argv[3] ?? 20);
const HUB_ID = "ddp";
const RADIUS = 1000;
const NOW = Date.now();
const SNAPSHOT = existsSync(join(root, "worker/hubSnapshot.ts"));

const bundle = async (contents) =>
  (
    await esbuild({
      stdin: { contents, resolveDir: root, loader: "ts" },
      bundle: true, write: false, format: "esm", platform: "neutral", mainFields: ["module", "main"],
      external: ["cloudflare:*"],
    })
  ).outputFiles[0].text;

// Node 쪽: 행 만들기 (bench-places.mjs와 같은 방식 — 실제 상세 픽스처 → saveDetail과 같은 열·조각)
const helpers = await bundle(`export { parseDetail } from "./worker/detailParser";
  export { storedListJson } from "./worker/present";
  export { detailRow } from "./worker/repo";
  export { categoryGroup } from "./shared/category";
  export { HUBS } from "./shared/hubs";
  export { tileKeyOf, boundingBox, haversine, tilesCoveringCircle } from "./shared/geo";`);
const mod = await import(`data:text/javascript;base64,${Buffer.from(helpers).toString("base64")}`);
const HUB = mod.HUBS.find((h) => h.id === HUB_ID);

// Worker 쪽: 실제 앱(엣지 캐시 없음 = 언제나 미스) + 측정용 스냅샷 만들기 경로
const worker = await bundle(`import { createApp } from "./worker/app";
  ${SNAPSHOT ? 'import { buildHubSnapshot } from "./worker/hubSnapshot";' : ""}
  import { HUBS } from "./shared/hubs";
  const app = createApp({ fetcher: async () => new Response("", { status: 500 }), rateLimit: async () => true, sleep: async () => {} });
  export default {
    async fetch(req, env, ctx) {
      const u = new URL(req.url);
      ${SNAPSHOT ? `if (u.pathname === "/__bench/build") {
        const r = await buildHubSnapshot(env.DB, HUBS.find((h) => h.id === u.searchParams.get("hub")), Date.now());
        return Response.json(r);
      }
      if (u.pathname === "/__bench/gzip") {
        // 스냅샷 본문을 풀어 둔 뒤 n번 gzip한다 (n=1과 n=11의 차이 / 10 = gzip 한 번)
        const row = await env.DB.prepare("SELECT body FROM hub_snapshots WHERE hub = ?").bind(u.searchParams.get("hub")).first();
        const gz = Uint8Array.fromBase64(row.body);
        const raw = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
        let out = 0;
        for (let i = 0; i < Number(u.searchParams.get("n")); i++) {
          const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
          out = z.byteLength;
        }
        return Response.json({ raw: raw.byteLength, gzip: out });
      }` : ""}
      return app.fetch(req, env, ctx);
    },
  };`);

// Miniflare 5 설정 (workers[].config: manifest + env)
const text = (value) => ({ type: "text", value });
const mf = new Miniflare({
  workers: [{
    config: {
      name: "bench",
      compatibilityDate: "2026-08-01",
      manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: worker } } },
      env: {
        DB: { type: "d1", id: "bench" },
        KAKAO_REST_KEY: text("x"), SUBREQUEST_BUDGET: text("40"), DETAIL_BATCH_SIZE: text("10"),
      },
    },
  }],
});
const db = await mf.getD1Database("DB");

// 마이그레이션 (주석 줄을 빼고 ;로 나눈다)
for (const f of readdirSync(join(root, "migrations")).filter((x) => x.endsWith(".sql")).sort()) {
  const sql = readFileSync(join(root, "migrations", f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(stmt).run();
}

const dir = join(root, "test/fixtures/place-detail");
const parsed = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => mod.parseDetail(JSON.parse(readFileSync(join(dir, f), "utf8"))))
  .filter((r) => r.ok);
let seed = 42;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x1_0000_0000);
const box = mod.boundingBox(HUB, RADIUS);
const rows = [];
let inCircle = 0;
for (let i = 0; inCircle < N; i++) {
  const lat = box.minLat + rand() * (box.maxLat - box.minLat);
  const lng = box.minLng + rand() * (box.maxLng - box.minLng);
  if (mod.haversine(HUB, { lat, lng }) <= RADIUS) inCircle++;
  const { summary: s, detail: d } = parsed[i % parsed.length];
  const id = String(100000000 + i * 7919);
  const salt = Math.floor(rand() * 1e6).toString(36);
  const menus = d.menus.map((m, k) => ({ name: `${m.name}${k ? "" : salt}`, price: m.price + (i % 5) * 500 }));
  const name = `${s.name} ${salt}`;
  const photo = s.photoUrl ? `${s.photoUrl}?${salt}` : null;
  const fetchedAt = NOW - (i % 1000) * 60_000;
  rows.push([
    id, name, s.categoryName, mod.categoryGroup(s.categoryName), lat, lng, s.address, s.phone, photo, d.rating, d.reviewCount,
    d.price, JSON.stringify(menus), d.hours ? JSON.stringify(d.hours) : null, JSON.stringify(d.strengths), JSON.stringify(d.tags),
    d.bookable === null ? null : d.bookable ? 1 : 0, fetchedAt,
    mod.storedListJson(mod.detailRow(id, { ...s, name, lat, lng, photoUrl: photo }, { ...d, menus }, fetchedAt)),
    mod.tileKeyOf({ lat, lng }),
  ]);
}
const cols = ["id", "name", "category_name", "category_group", "lat", "lng", "address", "phone", "photo_url", "rating",
  "review_count", "price", "menus_json", "hours_json", "strengths_json", "tags_json", "bookable", "fetched_at", "list_json"];
for (let i = 0; i < rows.length; i += 200) {
  const chunk = JSON.stringify(rows.slice(i, i + 200));
  await db
    .prepare(`INSERT INTO places (status, ${cols.join(", ")}) SELECT 'ok', ${cols.map((_, k) => `json_extract(value, '$[${k}]')`).join(", ")} FROM json_each(?)`)
    .bind(chunk)
    .run();
  await db.prepare("INSERT OR IGNORE INTO tile_places (tile_key, place_id) SELECT json_extract(value, '$[19]'), json_extract(value, '$[0]') FROM json_each(?)").bind(chunk).run();
}
for (const k of mod.tilesCoveringCircle(HUB, RADIUS)) {
  await db.prepare("INSERT OR REPLACE INTO tiles (key, collected_at, place_count, saturated) VALUES (?, ?, 0, 0)").bind(k, NOW).run();
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const readsToday = async () =>
  Number((await db.prepare("SELECT value FROM meta WHERE key LIKE 'd1_read:%'").first())?.value ?? 0);
const URL_ = `http://localhost/api/places?hub=${HUB_ID}&radius=1000`;

let liveBody = null;
async function measure(label, headers = {}) {
  for (let i = 0; i < 3; i++) await (await mf.dispatchFetch(URL_, { headers })).arrayBuffer();
  const times = [];
  let bytes = 0;
  let source = null;
  let reads = 0;
  let last = "";
  for (let i = 0; i < RUNS; i++) {
    const before = await readsToday();
    const t0 = performance.now();
    const res = await mf.dispatchFetch(URL_, { headers });
    const buf = await res.arrayBuffer();
    times.push(performance.now() - t0);
    bytes = buf.byteLength;
    last = Buffer.from(buf).toString("utf8");
    source = res.headers.get("x-mmj-source");
    // 사용량 기록은 waitUntil이라 조금 기다린다
    await new Promise((r) => setTimeout(r, 20));
    reads = (await readsToday()) - before;
  }
  // Miniflare(undici)는 gzip을 한 번 푼다 — 두 번 압축됐으면(encodeBody가 빠짐) 본문이 지금 경로와 달라진다
  liveBody ??= last;
  const sameAsLive = bytes === 0 ? null : last === liveBody;
  console.log(JSON.stringify({ path: label, source, places: N, runs: RUNS, wallMedianMs: Number(median(times).toFixed(2)), bytes, d1RowsRead: reads, sameAsLive }));
}

// 요청 하나의 바닥값 (Miniflare 왕복)
{
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await (await mf.dispatchFetch("http://localhost/api/health")).arrayBuffer();
    times.push(performance.now() - t0);
  }
  console.log(JSON.stringify({ path: "health (baseline)", wallMedianMs: Number(median(times).toFixed(2)) }));
}
await measure("live");
if (SNAPSHOT) {
  const times = [];
  let r;
  for (let i = 0; i < Math.max(5, Math.floor(RUNS / 2)); i++) {
    const t0 = performance.now();
    r = await (await mf.dispatchFetch(`http://localhost/__bench/build?hub=${HUB_ID}`)).json();
    times.push(performance.now() - t0);
  }
  console.log(JSON.stringify({ path: "build", result: r, wallMedianMs: Number(median(times).toFixed(2)) }));
  await measure("snapshot (gzip client)", { "accept-encoding": "gzip" });
  await measure("snapshot (identity client)", { "accept-encoding": "identity" });
  const etag = (await mf.dispatchFetch(URL_, { headers: { "accept-encoding": "gzip" } })).headers.get("etag");
  await measure("snapshot 304", { "accept-encoding": "gzip", "if-none-match": etag });
  const gz = async (n) => {
    const t0 = performance.now();
    await (await mf.dispatchFetch(`http://localhost/__bench/gzip?hub=${HUB_ID}&n=${n}`)).json();
    return performance.now() - t0;
  };
  const one = [];
  const eleven = [];
  for (let i = 0; i < 7; i++) {
    one.push(await gz(1));
    eleven.push(await gz(11));
  }
  console.log(JSON.stringify({ path: "gzip once (workerd CompressionStream)", wallMs: Number(((median(eleven) - median(one)) / 10).toFixed(2)) }));
}
await mf.dispose();
