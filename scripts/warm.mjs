import { readFileSync } from "node:fs";
import { areasFromArgs } from "./area.mjs";
import { SERVER_ERROR_LIMIT } from "./backfillGuard.mjs";
import { nextTruncatedStreak, on429, onWarmFailure, RATE_LIMIT_RETRIES, TRUNCATED_STOP_AFTER, warmLine } from "./warmRetry.mjs";

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
  console.error("ADMIN_TOKEN이 없어요 (.dev.vars 또는 환경 변수)");
  process.exit(1);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function warm({ label, lat, lng, radius }) {
  console.log(`== ${label} · 반경 ${radius}m`);
  let rateLimited = 0; // 연속으로 rate_limited를 받은 횟수
  let truncated = 0; // 후보 고르기가 쪽 상한에서 멈춰 아무것도 못 한 응답이 이어진 횟수 (Task 34)
  let serverErrors = 0; // 연속으로 받은 5xx·네트워크 오류
  for (let i = 1; i <= 300; i++) {
    let res;
    try {
      res = await fetch(`${base}/api/admin/warm?lat=${lat}&lng=${lng}&radius=${radius}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      // 네트워크가 잠깐 끊겨도 --all 전체를 끝내지 않는다 — 5xx처럼 몇 번만 기다렸다 다시
      serverErrors++;
      const next = onWarmFailure(0, serverErrors);
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
      if (next.reason === "read_budget") {
        // R38: 오늘 D1 읽기가 소프트 한도(D1_READ_SOFT_CAP)를 넘었다. 다시 두드리면 읽기만 더 쓴다
        console.error(`#${i} HTTP 429 ${body} — 오늘 D1 읽기 예산을 다 써서 멈춰요. 한도는 매일 09:00 KST(00:00 UTC)에 초기화되니 그 뒤에 다시 실행하세요.`);
      } else if (next.reason === "rate_limited") {
        console.error(`#${i} HTTP 429 ${body} — ${RATE_LIMIT_RETRIES}번 기다려도 요청 제한이 풀리지 않아 멈춰요. 몇 분 뒤 다시 실행하세요.`);
      } else {
        console.error(`#${i} HTTP 429 ${body} — 알 수 없는 429라 멈춰요.`);
      }
      process.exit(2);
    }
    rateLimited = 0;
    if (!res.ok) {
      // 4xx(401 토큰·400 인자·403 read_only)는 다시 해도 같다 — 멈춘다. 5xx는 연속 몇 번까지만 (backfill.mjs와 같다)
      const server = res.status >= 500 || res.status < 400;
      if (server) serverErrors++;
      const next = onWarmFailure(res.status, serverErrors);
      const text = await res.text();
      if (next.action === "stop") {
        console.error(
          server
            ? `#${i} HTTP ${res.status} ${text} — 연속 ${SERVER_ERROR_LIMIT}번 서버 오류라 멈춰요. 배포·CPU 한도(503)·D1 상태를 확인하고 다시 실행하세요.`
            : `#${i} HTTP ${res.status} ${text} — 다시 해도 같아 멈춰요 (토큰·인자·읽기 전용을 확인하세요).`,
        );
        process.exit(1);
      }
      console.error(`#${i} HTTP ${res.status} ${text} — ${next.waitMs / 1000}초 기다렸다 다시 해요 (${serverErrors}/${SERVER_ERROR_LIMIT})`);
      await wait(next.waitMs);
      continue;
    }
    serverErrors = 0;
    const r = await res.json();
    // deferred·chars·truncated·enrichError(보충 저장 오류 — 원인은 Workers 로그)까지 한 줄로 (warmRetry.mjs warmLine)
    console.log(warmLine(i, r));
    if (r.incompleteTiles === 0 && r.pending === 0) {
      console.log("완료");
      return true;
    }
    truncated = nextTruncatedStreak(r, truncated);
    if (truncated >= TRUNCATED_STOP_AFTER) {
      // 가까운 칸에 아직 만료되지 않은(지터 창 안) 상세가 많아 후보를 못 골랐다 — 다시 두드려도 읽기만 쓴다
      console.error(`#${i} 후보 고르기가 ${TRUNCATED_STOP_AFTER}번 연속 쪽 상한에서 멈춰 아무것도 못 했어요. 몇 시간 뒤(상세가 만료된 뒤) 다시 실행하거나 ?count=1로 남은 수를 확인하세요.`);
      return false;
    }
    await wait(1000);
  }
  console.error("300회 안에 끝나지 않았어요");
  return false;
}

let ok = true;
for (const area of areasFromArgs(process.argv.slice(2))) ok = (await warm(area)) && ok;
process.exit(ok ? 0 : 1);
