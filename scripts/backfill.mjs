// R12 (Task 28b): 배포 직후 0005 전 행의 list_json을 채운다 — POST /api/admin/backfill을 남은 것이 없을 때까지 1초 간격으로 부른다.
//   ADMIN_TOKEN=... npm run backfill -- --hub ddp   # 그 거점 격자만
//   ADMIN_TOKEN=... npm run backfill                # 모든 거점 격자
//   ADMIN_TOKEN=... npm run backfill -- --limit 200 # 한 번에 채우는 행 수 (1~300, 기본 300 — CPU가 빠듯하면 줄인다)
// 토큰은 환경 변수(없으면 .dev.vars)에서 읽고 출력하지 않는다. MMJ_BASE로 주소를 바꿀 수 있다.
import { readFileSync } from "node:fs";
import { HUBS } from "../shared/hubs.ts";
import { on5xx, parseBackfillArgs, SERVER_ERROR_LIMIT } from "./backfillGuard.mjs";
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

const parsed = parseBackfillArgs(process.argv.slice(2), HUBS.map((h) => h.id));
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(1);
}
const { hub, limit } = parsed;

const MAX_CALLS = 200;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const query = new URLSearchParams();
if (hub) query.set("hub", hub);
if (limit) query.set("limit", String(limit));
const url = `${base}/api/admin/backfill${query.size ? `?${query}` : ""}`;

console.log(`== list_json 백필 · ${hub ?? "모든 거점"}${limit ? ` · limit ${limit}` : ""}`);
let total = 0;
let read = 0;
let written = 0;
let rateLimited = 0; // 연속으로 rate_limited를 받은 횟수
let serverErrors = 0; // 연속으로 5xx를 받은 횟수
for (let i = 1; i <= MAX_CALLS; i++) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    // 네트워크가 잠깐 끊겨도 전체를 끝내지 않는다 — 5xx처럼 연속 몇 번만 기다렸다 다시 (Task 56)
    serverErrors++;
    const next = on5xx(serverErrors);
    if (next.action === "stop") {
      console.error(`#${i} 네트워크 오류 (${e instanceof Error ? e.message : e}) — 연속 ${SERVER_ERROR_LIMIT}번이라 멈춰요. 연결을 확인하고 다시 실행하세요.`);
      process.exit(1);
    }
    console.error(`#${i} 네트워크 오류 (${e instanceof Error ? e.message : e}) — ${next.waitMs / 1000}초 기다렸다 다시 해요 (${serverErrors}/${SERVER_ERROR_LIMIT})`);
    await wait(next.waitMs);
    continue;
  }
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
  if (res.status < 500) serverErrors = 0;
  if (res.status >= 400 && res.status < 500) {
    console.error(`#${i} HTTP ${res.status} ${await res.text()} — 멈춰요.`);
    process.exit(1);
  }
  if (!res.ok) {
    // 5xx(또는 3xx 같은 예상 밖 응답): 연속 SERVER_ERROR_LIMIT번이면 서버 문제라 멈춘다
    serverErrors++;
    const next = on5xx(serverErrors);
    const text = await res.text();
    if (next.action === "stop") {
      console.error(`#${i} HTTP ${res.status} ${text} — 연속 ${SERVER_ERROR_LIMIT}번 서버 오류라 멈춰요. 배포·D1 상태를 확인하고 다시 실행하세요.`);
      process.exit(1);
    }
    console.error(`#${i} HTTP ${res.status} ${text} — ${next.waitMs / 1000}초 기다렸다 다시 해요 (${serverErrors}/${SERVER_ERROR_LIMIT})`);
    await wait(next.waitMs);
    continue;
  }
  serverErrors = 0;
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
