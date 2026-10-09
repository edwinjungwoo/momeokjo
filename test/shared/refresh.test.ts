import { describe, expect, it } from "vitest";
import { HUBS } from "../../shared/hubs";
import { REFRESH_DAY_NAMES, isRefreshDay, refreshNoteText, refreshStart } from "../../shared/refresh";

/** KST 시각 → epoch ms */
const kst = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);

describe("R63 거점별 주 1회 갱신 요일", () => {
  it("R63: 모든 거점에 갱신 요일(KST, 0=일 ~ 6=토)이 있고, 사용자가 정한 대로다 (일요일은 없음)", () => {
    for (const h of HUBS) expect(isRefreshDay(h.refreshDay), h.id).toBe(true);
    expect(Object.fromEntries(HUBS.map((h) => [h.id, h.refreshDay]))).toEqual({
      bongeunsa: 1, seonjeongneung: 1, seolleung: 1, samseong: 1, ddp: 2, pangyo: 3, naebang: 3, gwacheon: 4, gwanghwamun: 4, cityhall: 4, euljiro1ga: 4, gangnam: 5, yeoksam: 5, yeouido: 6,
    });
    expect(HUBS.some((h) => h.refreshDay === 0)).toBe(false);
    for (const bad of [-1, 7, 1.5, "1", null, undefined, Number.NaN]) expect(isRefreshDay(bad), String(bad)).toBe(false);
  });

  it("R63: 갱신 시작은 지금 이하인 가장 최근의 그 요일 00:00 KST다 (그날 00:00 정각이면 그 시각)", () => {
    // 2026-10-06은 화요일 (KST)
    const tue10 = kst(2026, 10, 6, 10);
    expect(new Date(tue10 + 9 * 3600_000).getUTCDay()).toBe(2);
    expect(refreshStart(2, tue10)).toBe(kst(2026, 10, 6)); // 화: 오늘 00:00
    expect(refreshStart(1, tue10)).toBe(kst(2026, 10, 5)); // 월: 어제
    expect(refreshStart(3, tue10)).toBe(kst(2026, 9, 30)); // 수: 지난주
    expect(refreshStart(0, tue10)).toBe(kst(2026, 10, 4)); // 일
    expect(refreshStart(6, tue10)).toBe(kst(2026, 10, 3)); // 토
    // 경계: 화 00:00 정각은 새 시작, 1ms 전은 지난주 화요일
    expect(refreshStart(2, kst(2026, 10, 6))).toBe(kst(2026, 10, 6));
    expect(refreshStart(2, kst(2026, 10, 6) - 1)).toBe(kst(2026, 9, 29));
    // UTC로는 아직 월요일(15:00 UTC)이어도 KST 화요일 00:00이 기준이다
    expect(new Date(kst(2026, 10, 6)).getUTCDay()).toBe(1);
    // 언제나 지금 이하, 7일보다 짧게 지났다
    for (let t = kst(2026, 10, 1); t < kst(2026, 10, 15); t += 3600_000 * 7 + 13) {
      for (let d = 0; d < 7; d++) {
        const s = refreshStart(d, t);
        expect(s).toBeLessThanOrEqual(t);
        expect(t - s).toBeLessThan(7 * 24 * 3600_000);
        expect(new Date(s + 9 * 3600_000).getUTCDay()).toBe(d);
        expect((s + 9 * 3600_000) % (24 * 3600_000)).toBe(0);
      }
    }
  });

  it("R63: 화면 문구 — 완료한 적이 있으면 그 날짜(KST)와 요일, 없으면 요일만", () => {
    expect(REFRESH_DAY_NAMES).toEqual(["일", "월", "화", "수", "목", "금", "토"]);
    expect(refreshNoteText(kst(2026, 10, 5, 13, 20), 1)).toBe("가게 정보 10월 5일(월) 업데이트 · 매주 월요일");
    // 완료가 다음 날로 넘어가면 그 날짜 그대로 (KST 자정 직후)
    expect(refreshNoteText(kst(2026, 10, 7, 0, 5), 2)).toBe("가게 정보 10월 7일(수) 업데이트 · 매주 화요일");
    expect(refreshNoteText(null, 6)).toBe("매주 토요일 업데이트");
  });
});
