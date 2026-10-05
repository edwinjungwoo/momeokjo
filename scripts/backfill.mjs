// R12 (Task 28b): 배포 직후 0005 전 행의 list_json을 채운다 — POST /api/admin/backfill을 남은 것이 없을 때까지 1초 간격으로 부른다.
//   ADMIN_TOKEN=... npm run backfill -- --hub ddp   # 그 거점 격자만
//   ADMIN_TOKEN=... npm run backfill                # 모든 거점 격자
// 토큰은 환경 변수(없으면 .dev.vars)에서 읽고 출력하지 않는다. MMJ_BASE로 주소를 바꿀 수 있다.
import { readFileSync } from "node:fs";
import { HUBS } from "../shared/hubs.ts";
import { on429, RATE_LIMIT_RETRIES } from "./warmRetry.mjs";

const base = process.env.MMJ_BASE ?? "https://mmj.itmz.me";
const fromDevVars = () => {
  try {
    return readFileSync(".dev.vars", "utf8").match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
};
const token = process.env.ADMIN_TOKEN ?? fromDevVars();
if (!token) {
  console.error("ADMIN_TOKEN이 없어요 (환경 변수 또는 .dev.vars)");
  process.exit(1);
}

const args = process.argv.slice(2);
let hub;
if (args[0] === "--hub") {
  hub = args[1];
  if (!HUBS.some((h) => h.id === hub)) {
    console.error(`모르는 거점이에요: ${hub} (가능: ${HUBS.map((h) => h.id).join(", ")})`);
    process.exit(1);
  }
} else if (args.length > 0) {
  console.error("사용법: npm run backfill [-- --hub <거점 id>]");
  process.exit(1);
}

const MAX_CALLS = 200;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const url = `${base}/api/admin/backfill${hub ? `?hub=${encodeURIComponent(hub)}` : ""}`;

console.log(`== list_json 백필 · ${hub ?? "모든 거점"}`);
let total = 0;
let read = 0;
let written = 0;
let rateLimited = 0; // 연속으로 rate_limited를 받은 횟수
for (let i = 1; i <= MAX_CALLS; i++) {
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    const body = await res.text();
    const next = on429(body, rateLimited);
    if (next.action === "retry") {
      // R36: 관리자 전용 제한(ADMIN_LIMITER)에 걸렸다 — 창이 지나길 기다렸다 같은 요청을 다시 한다
      rateLimited++;
      console.error(`#${i} HTTP 429 ${body} — 요청이 너무 잦아요. ${next.waitMs / 1000}초 기다렸다 다시 해요 (${rateLimited}/${RATE_LIMIT_RETRIES})`);
      await wait(next.waitMs);
      i--;
      continue;
    }
    if (next.reason === "read_budget" || next.reason === "write_budget") {
      // R38: 오늘 D1 읽기·쓰기가 소프트 한도를 넘었다. 남은 행은 Cron이 실행마다 200행씩 채운다
      const what = next.reason === "read_budget" ? "읽기" : "쓰기";
      console.error(`#${i} HTTP 429 ${body} — 오늘 D1 ${what} 예산을 다 써서 멈춰요. 남은 행은 Cron이 채우고, 한도는 매일 09:00 KST(00:00 UTC)에 초기화돼요.`);
    } else if (next.reason === "rate_limited") {
      console.error(`#${i} HTTP 429 ${body} — ${RATE_LIMIT_RETRIES}번 기다려도 요청 제한이 풀리지 않아 멈춰요. 몇 분 뒤 다시 실행하세요.`);
    } else {
      console.error(`#${i} HTTP 429 ${body} — 알 수 없는 429라 멈춰요.`);
    }
    process.exit(2);
  }
  rateLimited = 0;
  if (res.status >= 400 && res.status < 500) {
    console.error(`#${i} HTTP ${res.status} ${await res.text()} — 멈춰요.`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`#${i} HTTP ${res.status} ${await res.text()}`);
    await wait(3000);
    continue;
  }
  const r = await res.json();
  total += r.filled;
  read += r.rowsRead;
  written += r.rowsWritten;
  console.log(`#${i} filled=${r.filled} remaining=${r.remaining} rowsRead=${r.rowsRead} rowsWritten=${r.rowsWritten}`);
  if (r.remaining === 0) {
    console.log(`완료 — 채운 행 ${total}, 읽은 행 ${read}, 쓴 행 ${written}`);
    process.exit(0);
  }
  await wait(1000);
}
console.error(`${MAX_CALLS}회 안에 끝나지 않았어요 — 채운 행 ${total}`);
process.exit(1);
