import { readFileSync } from "node:fs";
import { areasFromArgs } from "./area.mjs";

const base = process.env.MMJ_BASE ?? "https://mmj.itmz.me";
// 토큰은 환경 변수(없으면 .dev.vars)에서 읽고 출력하지 않는다. 없으면 요청하지 않고 멈춘다 (warm.mjs·backfill.mjs와 같다)
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
const [{ label, lat, lng, radius }] = areasFromArgs(process.argv.slice(2));

const res = await fetch(`${base}/api/admin/audit?lat=${lat}&lng=${lng}&radius=${radius}`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) {
  console.error(`HTTP ${res.status} ${await res.text()}`);
  process.exit(1);
}
const r = await res.json();
console.log(`${label} (${lat}, ${lng}) · 반경 ${radius}m · 덮는 격자의 장소 ID ${r.places}개`);
console.log("\n[Q1] 격자"); console.table(r.tiles);
console.log("[Q2] 상세 커버리지"); console.table(r.detail);
console.log("[Q3] 결측률 (ok 중)"); console.table(r.nullRates);
console.log("[Q4] 그룹 분포"); console.table(r.byGroup);
console.log("[Q4] etc로 떨어진 2단계"); console.table(r.etcSecondLevels);
console.log(`[Q4] 좌표 이상 ${r.invalidCoords}건, 중복 의심 ${r.duplicateGroups}묶음`);
if (r.failures.length) { console.log("실패 목록 (최대 50)"); console.table(r.failures); }
console.log(`\nQ1 ${r.pass.q1 ? "통과" : "실패"} · Q2 ${r.pass.q2 ? "통과" : "실패"}`);
process.exit(r.pass.q1 && r.pass.q2 ? 0 : 1);
