import { readFileSync } from "node:fs";

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
const [lat = "37.513059", lng = "127.059826", radius = "1500"] = process.argv.slice(2);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 1; i <= 300; i++) {
  const res = await fetch(`${base}/api/admin/warm?lat=${lat}&lng=${lng}&radius=${radius}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`#${i} HTTP ${res.status} ${await res.text()}`);
    await wait(3000);
    continue;
  }
  const r = await res.json();
  console.log(`#${i} incompleteTiles=${r.incompleteTiles} pending=${r.pending} enriched=${r.enriched} failed=${r.failed}`);
  if (r.incompleteTiles === 0 && r.pending === 0) {
    console.log("완료");
    process.exit(0);
  }
  await wait(1000);
}
console.error("300회 안에 끝나지 않았어요");
process.exit(1);
