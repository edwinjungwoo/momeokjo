// Task 28 (#5): 목록 캐시가 비었을 때 Worker가 동대문 1000m 응답(~2,000곳)을 만드는 CPU 비용을 잰다.
// 배포하지 않는 측정 도구다. 실제 코드(getPlaces → listRowsInBox → 조각 이어 붙이기 → placesBody)를 esbuild로 묶어 그대로 부르고,
// D1만 SQL 앞부분으로 답하는 가짜로 바꾼다. 행은 실제 상세 픽스처를 parseDetail → saveDetail과 같은 열 모양으로 만든다.
// 두 길을 잰다: list_json 있음(0005 뒤 저장된 행) / 없음(예전 행 — 열 4개 JSON.parse → toApiPlace → stringify).
// 실행: node scripts/bench-places.mjs [곳 수=2000] [반복=60]
import { build as esbuild } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const N = Number(process.argv[2] ?? 2000);
const RUNS = Number(process.argv[3] ?? 60);
const HUB = { lat: 37.5651, lng: 127.00749 }; // 동대문역사문화공원역
const RADIUS = 1000;
const NOW = 1_800_000_000_000;

const out = await esbuild({
  stdin: {
    contents: `export { getPlaces } from "./worker/placesService";
      export { parseDetail } from "./worker/detailParser";
      export { placesBody, listItemJson } from "./worker/present";
      export { detailRow } from "./worker/repo";
      export { categoryGroup } from "./shared/category";
      export { tileKeyOf, boundingBox, haversine } from "./shared/geo";`,
    resolveDir: root,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
  mainFields: ["module", "main"],
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

// 1) 픽스처에서 상세 모양을 얻는다
const dir = join(root, "test/fixtures/place-detail");
const parsed = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => mod.parseDetail(JSON.parse(readFileSync(join(dir, f), "utf8"))))
  .filter((r) => r.ok);

// 2) 2,000곳을 반경 안에 고르게 흩고, 상자 모서리(반경 밖)에도 같은 밀도로 둔다 (placesInBox가 실제로 읽는 행)
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
  rows.push({
    id, status: "ok", name: `${s.name} ${salt}`, category_name: s.categoryName, category_group: mod.categoryGroup(s.categoryName),
    lat, lng, address: s.address, phone: s.phone, photo_url: s.photoUrl ? `${s.photoUrl}?${salt}` : null,
    rating: d.rating, review_count: d.reviewCount, price: d.price, menus_json: JSON.stringify(menus),
    hours_json: d.hours ? JSON.stringify(d.hours) : null, strengths_json: JSON.stringify(d.strengths),
    tags_json: JSON.stringify(d.tags), bookable: d.bookable === null ? null : d.bookable ? 1 : 0, fail_reason: null,
    fetched_at: NOW - (i % 1000) * 60_000,
  });
  const r = rows[rows.length - 1];
  r.list_json = mod.listItemJson(mod.detailRow(id, { ...s, name: r.name, lat, lng, photoUrl: r.photo_url }, { ...d, menus }, r.fetched_at));
}
const tileOf = new Map(rows.map((r) => [r.id, mod.tileKeyOf(r)]));

// 3) getPlaces가 부르는 D1 문장만 흉내 낸다 (모든 격자 신선, 상세 모두 있음 → 외부 호출·보충 없음)
const fakeDb = {
  prepare(sql) {
    let args = [];
    const stmt = {
      bind: (...a) => ((args = a), stmt),
      async all() {
        if (sql.includes("FROM tiles")) return { results: args.map((key) => ({ key, collected_at: NOW, saturated: 0 })) };
        if (sql.includes("FROM tile_places tp LEFT JOIN places")) {
          const keys = new Set(args);
          return {
            results: rows
              .filter((r) => keys.has(tileOf.get(r.id)))
              .map((r) => ({ id: r.id, tile_key: tileOf.get(r.id), status: "ok", fetched_at: r.fetched_at, fail_reason: null })),
          };
        }
        if (sql.includes("CASE WHEN list_json IS NULL")) return { results: rows.map((r) => (withJson ? { ...r } : { ...r, list_json: null })) };
        if (sql.includes("FROM meta")) return { results: [] };
        throw new Error(`unexpected sql: ${sql}`);
      },
    };
    return stmt;
  },
};
const deps = {
  db: fakeDb, fetcher: async () => new Response("", { status: 500 }), restKey: "x", budgetSize: 40, batchSize: 10,
  now: NOW, rateLimit: async () => true, waitUntil: () => {},
};

// 4) 잰다: 응답 만들기(getPlaces) + 본문(placesBody). 가짜 D1이 행을 복사하는 시간은 따로 빼서 보여 준다
let withJson = true;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const build = async () => {
  const { items, ...meta } = await mod.getPlaces(deps, HUB, RADIUS);
  return { body: mod.placesBody(meta, items), count: items.length };
};
const bodies = {};
for (const mode of [false, true, false, true]) {
  withJson = mode;
  for (let i = 0; i < 15; i++) await build();
  const total = [];
  const copy = [];
  let out;
  for (let i = 0; i < RUNS; i++) {
    const c0 = performance.now();
    rows.map((r) => ({ ...r }));
    copy.push(performance.now() - c0);
    const t0 = performance.now();
    out = await build();
    total.push(performance.now() - t0);
  }
  bodies[mode] = out.body;
  const m = median(total) - median(copy);
  console.log(JSON.stringify({
    path: mode ? "list_json" : "columns", node: process.version, rowsInBox: rows.length, places: out.count,
    bodyChars: out.body.length, runs: RUNS, medianMs: Number(m.toFixed(2)), workersEstimateMs: Number((m * 3).toFixed(2)),
  }));
}
console.log(JSON.stringify({ sameBody: bodies.true === bodies.false }));
