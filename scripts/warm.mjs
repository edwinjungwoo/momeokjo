import { readFileSync } from "node:fs";
import { areasFromArgs } from "./area.mjs";

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
  for (let i = 1; i <= 300; i++) {
    const res = await fetch(`${base}/api/admin/warm?lat=${lat}&lng=${lng}&radius=${radius}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 429) {
      // R38: 오늘 D1 읽기가 소프트 한도(D1_READ_SOFT_CAP)를 넘었다. 다시 두드리면 읽기만 더 쓴다
      console.error(`#${i} HTTP 429 ${await res.text()} — 오늘 D1 읽기 예산을 다 써서 멈춰요. 내일(KST) 다시 실행하세요.`);
      process.exit(2);
    }
    if (!res.ok) {
      console.error(`#${i} HTTP ${res.status} ${await res.text()}`);
      await wait(3000);
      continue;
    }
    const r = await res.json();
    console.log(`#${i} incompleteTiles=${r.incompleteTiles} pending=${r.pending} enriched=${r.enriched} failed=${r.failed}`);
    if (r.incompleteTiles === 0 && r.pending === 0) {
      console.log("완료");
      return true;
    }
    await wait(1000);
  }
  console.error("300회 안에 끝나지 않았어요");
  return false;
}

let ok = true;
for (const area of areasFromArgs(process.argv.slice(2))) ok = (await warm(area)) && ok;
process.exit(ok ? 0 : 1);
