import { describe, expect, it } from "vitest";
import {
  CRON_STALE_MS, addDays, alertsOf, budgetFraction, budgetLevel, dayList, daysBetween, deltaOf, histogramMedian, isDay,
  METRICS, METRIC_FAMILIES, mondayOf, overBlockAfter, weekdayOf, type HubStatus, type OpsSnapshot,
} from "../../shared/dashboard";
import spec from "../../docs/superpowers/specs/2026-10-05-momeokjo-design.md?raw";

const NOW = 1_800_000_000_000;
const ops = (o: Partial<{ read: number; written: number; blockedUntil: number; frozen: OpsSnapshot["kakao"]["frozen"]; cronAt: number | null }> = {}): OpsSnapshot => ({
  budget: { utcDay: "2027-01-15", read: o.read ?? 0, written: o.written ?? 0, readSoftCap: 3_000_000, writeSoftCap: 60_000, resetAt: NOW },
  kakao: { blockedUntil: o.blockedUntil ?? 0, frozen: o.frozen ?? null, blocksToday: 0 },
  cron:
    o.cronAt === null
      ? null
      : { at: o.cronAt ?? NOW - 60_000, collected: 0, incomplete: 0, enriched: 0, failed: 0, calls: 0, rolled: 0 },
});
const hub = (h: Partial<HubStatus>): HubStatus => ({
  hub: "ddp", places: 10, ok: 10, failed: 0, pending: 0, visible: 10, listReady: 10, tiles: 4, incompleteTiles: 0,
  saturatedTiles: 0, oldestOkAt: NOW, lastTileAt: NOW, ...h,
});
const rollup = { through: "2027-01-14", yesterday: "2027-01-14" };

describe("대시보드 순수 계산", () => {
  it("R60: 예산 색 단계는 소프트 한도 대비 50/70/90 %에서 바뀐다", () => {
    expect([0, 0.499, 0.5, 0.699, 0.7, 0.899, 0.9, 1.2].map(budgetLevel)).toEqual([
      "ok", "ok", "notice", "notice", "warn", "warn", "crit", "crit",
    ]);
    expect(budgetLevel(Number.NaN)).toBe("ok");
  });

  it("R60: 예산 사용률은 읽기·쓰기 중 소프트 한도에 더 가까운 쪽", () => {
    expect(budgetFraction(ops({ read: 1_500_000, written: 48_000 }).budget)).toBeCloseTo(0.8);
    expect(budgetFraction(ops({ read: 2_400_000, written: 6_000 }).budget)).toBeCloseTo(0.8);
  });

  it("R60: 운영 조작은 이번 조작이 읽고 쓴 행까지 더해 예산 90 %를 넘으면 멈춘다", () => {
    const b = ops({ read: 2_400_000, written: 1000 }).budget; // 80 %
    expect(overBlockAfter(b, 200_000, 0)).toBe(false); // 86.7 %
    expect(overBlockAfter(b, 300_000, 0)).toBe(true); // 90 %
    expect(overBlockAfter(b, 0, 53_000)).toBe(true); // 쓰기 90 %
  });

  it("R58: 결정 시간 중앙값은 구간 안에서 선형 보간한다 (열린 마지막 구간이면 아래 경계)", () => {
    expect(histogramMedian([0, 0, 0, 0, 0, 0, 0])).toBeNull();
    // 10개 중 5번째: 10~30초 구간(4개) 안에서 (5 - 2) / 4 = 0.75 → 25초
    expect(histogramMedian([2, 4, 4, 0, 0, 0, 0])).toBeCloseTo(25);
    expect(histogramMedian([1, 0, 0, 0, 0, 0, 5])).toBe(900);
    expect(histogramMedian([0, 2, 0, 0, 0, 0, 0])).toBeCloseTo(20);
  });

  it("R57: 이전 기간 대비 증감률 (이전이 0이거나 없으면 null)", () => {
    expect(deltaOf(120, 100)).toBeCloseTo(0.2);
    expect(deltaOf(50, 100)).toBeCloseTo(-0.5);
    expect(deltaOf(5, 0)).toBeNull();
    expect(deltaOf(null, 3)).toBeNull();
  });

  it("R57: 날짜 계산 (KST 날짜 문자열, 월요일 시작 주)", () => {
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(dayList("2026-12-30", "2027-01-02")).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(dayList("2027-01-02", "2027-01-01")).toEqual([]);
    expect(daysBetween("2027-01-01", "2027-03-01")).toBe(59);
    expect([weekdayOf("2027-01-11"), weekdayOf("2027-01-17")]).toEqual([0, 6]);
    expect([mondayOf("2027-01-17"), mondayOf("2027-01-11")]).toEqual(["2027-01-11", "2027-01-11"]);
    expect([isDay("2027-02-29"), isDay("2027-02-28"), isDay("20270228")]).toEqual([false, true, false]);
  });

  it("R58: 지표 이름·묶음은 스펙 R58 표와 같다 (정의된 것은 모두 표에, 표에 있는 것은 모두 정의)", () => {
    const r53 = spec.slice(spec.indexOf("- **R58 "), spec.indexOf("- **R59 "));
    const rows = [...r53.matchAll(/^\s*\| `([^`]+)` \|/gm)].map((m) => m[1]);
    expect(rows.length).toBeGreaterThan(50);
    expect(new Set(rows)).toEqual(new Set([...Object.keys(METRICS), ...Object.keys(METRIC_FAMILIES)]));
  });

  it("R57: 이상 신호 — 예산 70 % 이상, 쿨다운·frozen, Cron 15분 멈춤, 미수집·미완료 거점, 집계 밀림 (심각한 것 먼저)", () => {
    expect(alertsOf(ops(), [hub({})], NOW, rollup)).toEqual([]);
    const a = alertsOf(
      ops({ read: 2_200_000, blockedUntil: NOW + 60_000, cronAt: NOW - CRON_STALE_MS - 60_000 }),
      [hub({ hub: "ddp", pending: 3 }), hub({ hub: "pangyo", incompleteTiles: 2 })],
      NOW,
      { through: "2027-01-10", yesterday: "2027-01-14" },
    );
    expect(a.map((x) => [x.level, x.code])).toEqual([
      ["crit", "cron"], ["warn", "budget"], ["warn", "cooldown"], ["info", "hub:ddp"], ["info", "hub:pangyo"], ["info", "rollup"],
    ]);
    const b = alertsOf(ops({ read: 2_800_000, frozen: { since: NOW - 1, until: NOW + 1 }, cronAt: null }), null, NOW, rollup);
    expect(b.map((x) => [x.level, x.code])).toEqual([["crit", "budget"], ["crit", "frozen"], ["warn", "cron"]]);
  });
});
