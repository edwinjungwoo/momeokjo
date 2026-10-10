import { describe, expect, it } from "vitest";
import type { PlacesResponse } from "../../shared/types";
import { DEFAULT_FILTERS, type Filters } from "../../shared/recommend";
import {
  MENU_PREVIEW, RATING_HIGH, callFirst, detailSummary, menuPreview, openState, priceText, ratingTone, refreshNote, rowSubLine, statusOf,
  telHref, todayHoursText, walkText, won,
} from "../../web/format";
import { relaxOptions } from "../../web/components/EmptyState";
import { apiPlace } from "../helpers/apiPlace";

const kst = (iso: string) => new Date(`${iso}+09:00`);
const DAY = 24 * 3600_000;

describe("R49 4명+면 전화 먼저", () => {
  it("R49: 전화번호를 tel: 링크로 — 숫자와 +만 남기고, 숫자가 없으면 null", () => {
    expect(telHref("02-1234-5678")).toBe("tel:0212345678");
    expect(telHref(" +82 2 1234 5678 ")).toBe("tel:+82212345678");
    expect(telHref("")).toBeNull();
    expect(telHref("없음")).toBeNull();
    expect(telHref(null)).toBeNull();
    expect(telHref(undefined)).toBeNull();
  });

  it("R49: 인원 4명+이고 전화번호가 있을 때만 \"전화로 자리 확인\"을 먼저 보여준다", () => {
    const withPhone = apiPlace("1", { phone: "02-555-0101" });
    expect(callFirst(withPhone, 4)).toBe("tel:025550101");
    for (const party of [1, 2, 3] as const) expect(callFirst(withPhone, party)).toBeNull();
    expect(callFirst(apiPlace("2", { phone: null }), 4)).toBeNull();
    // 목록 원소(단건을 아직 못 받음)에는 phone이 없다
    expect(callFirst(apiPlace("3", { phone: undefined }), 4)).toBeNull();
  });
});

describe("R63/R66 가게 정보 확인 한 줄", () => {
  const KST = 9 * 3600_000;
  const base = {
    center: { lat: 37.5, lng: 127 }, radius: 1000, places: [], pending: 0, incompleteTiles: 0, stale: false, detailsPaused: false,
    detailsFrozenSince: null, detailsNewestAt: null, refreshedAt: null, refreshDay: 1,
  } as PlacesResponse;

  it("R63/R66: 마지막 완료 날짜(KST)에 확인 · 새 가게 요일, 완료한 적이 없으면 새 가게 요일만 — 목록이 없으면 보이지 않는다", () => {
    const at = Date.UTC(2026, 9, 5, 14, 30) - KST; // 10월 5일(월) 14:30 KST
    expect(refreshNote({ ...base, refreshedAt: at }, 2)).toBe("가게 정보 10월 5일(월) 확인 · 새 가게는 매주 월요일");
    expect(refreshNote(base, 2)).toBe("새 가게는 매주 월요일 확인해요");
    expect(refreshNote(null, 1)).toBeNull();
  });

  it("R63: 서버는 끝낸 갱신의 시작(그 요일 00:00 KST)을 refreshedAt으로 준다 — 이틀 걸려 끝나도 갱신 요일 날짜로 보인다", () => {
    const friStart = Date.UTC(2026, 9, 9) - KST; // 10월 9일(금) 00:00 KST
    expect(refreshNote({ ...base, refreshedAt: friStart, refreshDay: 5 }, 5)).toBe("가게 정보 10월 9일(금) 확인 · 새 가게는 매주 금요일");
  });

  it("R63: 예전 기기 저장본(필드 없음)은 거점 설정의 요일로, 완료 날짜 없이 보여준다", () => {
    const { refreshedAt: _a, refreshDay: _d, ...old } = base;
    expect(refreshNote(old as PlacesResponse, 4)).toBe("새 가게는 매주 목요일 확인해요");
  });
});

describe("R22 펼친 결과 카드의 메뉴는 5개까지", () => {
  const menus = Array.from({ length: 8 }, (_, i) => ({ name: `메뉴${i + 1}`, price: 1000 * (i + 1) }));

  it("R22: 접힌 상태는 앞 5개만, 나머지 개수를 \"메뉴 N개 더 보기\"로 알린다", () => {
    expect(MENU_PREVIEW).toBe(5);
    const v = menuPreview(menus, false);
    expect(v.shown.map((m) => m.name)).toEqual(["메뉴1", "메뉴2", "메뉴3", "메뉴4", "메뉴5"]);
    expect(v.hidden).toBe(3);
  });

  it("R22: 더 보기를 누르면 전부, 5개 이하면 더 보기가 없다", () => {
    expect(menuPreview(menus, true)).toEqual({ shown: menus, hidden: 0 });
    expect(menuPreview(menus.slice(0, 5), false)).toEqual({ shown: menus.slice(0, 5), hidden: 0 });
    expect(menuPreview([], false)).toEqual({ shown: [], hidden: 0 });
  });
});

describe("R28 낮은 평점은 강조색으로 칭찬하지 않는다", () => {
  it("R28: 4.0 이상만 강조(high), 그 아래와 평점 없음은 차분한 글자색(plain)", () => {
    expect(RATING_HIGH).toBe(4);
    expect(ratingTone(4)).toBe("high");
    expect(ratingTone(4.9)).toBe("high");
    expect(ratingTone(3.99)).toBe("plain");
    expect(ratingTone(1.1)).toBe("plain");
    expect(ratingTone(0)).toBe("plain");
    expect(ratingTone(null)).toBe("plain");
  });
});

describe("R34/R28 목록 행 둘째 줄 — 375·360px에서 알약이 잘리지 않게", () => {
  it("R34: 상위 N%가 있으면 평점 옆에 짧은 알약(상위 N%)만, 카테고리는 빼고 — 없으면 평점 · 카테고리", () => {
    expect(rowSubLine({ top: 5, closed: false, category: "중국요리" })).toEqual({ pill: "상위 5%", category: null });
    expect(rowSubLine({ top: undefined, closed: false, category: "중국요리" })).toEqual({ pill: null, category: "중국요리" });
    expect(rowSubLine({ top: undefined, closed: false, category: null })).toEqual({ pill: null, category: null });
  });

  it("R34: 곧 닫거나 닫힌 줄은 그 알림이 먼저라 알약을 빼고 카테고리를 보인다 (한 줄에 셋을 넣지 않는다)", () => {
    expect(rowSubLine({ top: 5, closed: true, category: "한식" })).toEqual({ pill: null, category: "한식" });
  });
});

describe("R7/R26 가격·도보 글자", () => {
  it("R7: 원은 천 단위 쉼표, 대표 가격은 \"N원대\" (없으면 null)", () => {
    expect(won(12000)).toBe("12,000원");
    expect(won(0)).toBe("0원");
    expect(priceText(apiPlace("1", {}, { price: 9500 }))).toBe("9,500원대");
    expect(priceText(apiPlace("1", {}, { price: null }))).toBeNull();
    expect(priceText(apiPlace("1", {}, null))).toBeNull();
  });

  it("R26: 도보 분이 있으면 \"도보 N분\", 모르면 null", () => {
    expect(walkText(apiPlace("1", { walkMinutes: 7 }))).toBe("도보 7분");
    expect(walkText(apiPlace("1", { walkMinutes: undefined }))).toBeNull();
  });
});

describe("R17 영업 상태 글자", () => {
  const p = apiPlace("1", {}, { hours: { 1: [[660, 1320]] } });

  it("R17: 영업 중 / 30분 안에 닫힘(곧 마감, 강조) / 지금 닫힘(강조) / 정보 없음", () => {
    expect(openState(p, kst("2026-10-05T12:00:00"))).toEqual({ text: "영업 중", closed: false, kind: "open" });
    expect(openState(p, kst("2026-10-05T21:45:00"))).toEqual({ text: "곧 마감", closed: true, kind: "closing" });
    expect(openState(p, kst("2026-10-05T22:30:00"))).toEqual({ text: "지금 닫힘", closed: true, kind: "closed" });
    expect(openState(p, kst("2026-10-05T10:00:00"))).toEqual({ text: "지금 닫힘", closed: true, kind: "closed" });
    expect(openState(apiPlace("2", {}, { hours: null }), kst("2026-10-05T12:00:00"))).toEqual({
      text: "영업 정보 없음", closed: false, kind: "unknown",
    });
  });

  it("R22: 펼친 카드의 오늘 영업시간 — 구간이 여럿이면 쉼표로, 자정 넘김은 다음 날 시각으로, 휴무, 정보 없으면 null", () => {
    const mon = kst("2026-10-05T12:00:00");
    expect(todayHoursText(apiPlace("1", {}, { hours: { 1: [[660, 900], [1020, 1320]] } }), mon)).toBe("오늘 11:00~15:00, 17:00~22:00");
    expect(todayHoursText(apiPlace("1", {}, { hours: { 1: [[1080, 1620]] } }), mon)).toBe("오늘 18:00~03:00");
    expect(todayHoursText(apiPlace("1", {}, { hours: { 1: "closed" } }), mon)).toBe("오늘 휴무");
    expect(todayHoursText(apiPlace("1", {}, { hours: { 1: [] } }), mon)).toBeNull();
    expect(todayHoursText(apiPlace("1", {}, { hours: { 2: [[660, 1320]] } }), mon)).toBeNull();
    expect(todayHoursText(apiPlace("1", {}, null), mon)).toBeNull();
  });
});

describe("R18 상세 조건 접힘 한 줄", () => {
  it("R18: 기본값은 \"예산 전체 · 평점 무관 · 영업 중만\", 바꾸면 그 값으로 (꺼진 영업 중·술집은 빼고)", () => {
    expect(detailSummary(DEFAULT_FILTERS)).toBe("예산 전체 · 평점 무관 · 영업 중만");
    const f: Filters = { ...DEFAULT_FILTERS, priceCap: 15000, minRating: 3.5, openOnly: false, includeBar: true };
    expect(detailSummary(f)).toBe("1.5만 이하 · 평점 3.5+ · 술집 포함");
    expect(detailSummary({ ...DEFAULT_FILTERS, priceCap: 10000, minRating: 4 })).toBe("1만 이하 · 평점 4.0+ · 영업 중만");
  });
});

describe("R29/R44 목록 위 상태 한 줄", () => {
  const NOW = Date.UTC(2026, 9, 5, 3);
  const base = {
    center: { lat: 37.5, lng: 127 }, radius: 1000, places: [], pending: 0, incompleteTiles: 0, stale: false, detailsPaused: false,
    detailsFrozenSince: null, detailsNewestAt: NOW - DAY, refreshedAt: null, refreshDay: 1,
  } as PlacesResponse;

  it("R29: 목록이 없으면 null(스켈레톤·오류 화면이 대신), 다 찬 최신 목록이면 null", () => {
    expect(statusOf(null, false, false, NOW)).toBeNull();
    expect(statusOf(base, false, false, NOW)).toBeNull();
  });

  it("R29: 오류 → 오래됨(stale) → 격자 수집 중 → 평점 불러오는 중 순서로 하나만", () => {
    const all = { ...base, stale: true, incompleteTiles: 2, pending: 3 };
    expect(statusOf(all, true, true, NOW)).toEqual({ text: "최신 정보를 불러오지 못했어요", tone: "warn", busy: false });
    expect(statusOf(all, true, false, NOW)).toEqual({ text: "정보가 오래됐을 수 있어요", tone: "warn", busy: false });
    const collecting = { ...base, incompleteTiles: 2, pending: 3 };
    expect(statusOf(collecting, true, false, NOW)).toEqual({ text: "주변 가게를 더 찾는 중이에요", tone: "info", busy: true });
    expect(statusOf(collecting, false, false, NOW)).toEqual({ text: "주변 가게를 다 찾지 못했어요", tone: "warn", busy: false });
    const pending = { ...base, pending: 3 };
    expect(statusOf(pending, true, false, NOW)).toEqual({ text: "평점 정보 불러오는 중 (3곳)", tone: "info", busy: true });
    expect(statusOf(pending, false, false, NOW)).toEqual({ text: "3곳은 아직 정보를 못 불러왔어요", tone: "info", busy: false });
  });

  it("R44: 가장 최근 상세가 8일보다 오래됐으면 기준 시점을, frozen이면 pending보다 먼저 알린다 (예전 저장본에 필드가 없어도 된다)", () => {
    expect(statusOf({ ...base, detailsNewestAt: NOW - 10 * DAY }, false, false, NOW)).toEqual({
      text: "평점·메뉴는 10일 전 기준이에요", tone: "info", busy: false,
    });
    const frozen = { ...base, pending: 3, detailsFrozenSince: NOW - DAY, detailsNewestAt: NOW - 2 * DAY };
    expect(statusOf(frozen, true, false, NOW)).toEqual({ text: "평점·메뉴는 2일 전 기준이에요", tone: "info", busy: false });
    const { detailsFrozenSince: _f, detailsNewestAt: _n, ...old } = base;
    expect(statusOf(old as PlacesResponse, false, false, NOW)).toBeNull();
  });
});

describe("R21 후보가 없을 때 풀기 버튼", () => {
  it("R21: 켜져 있는 제약만 버튼으로 (영업 중 → 평점 → 예산 → 카테고리 → 반경 +300m), 누르면 그 제약만 푼다", () => {
    expect(relaxOptions(DEFAULT_FILTERS).map((o) => o.label)).toEqual(["영업 중만 해제", "반경 +300m"]);
    const tight: Filters = { ...DEFAULT_FILTERS, minRating: 4, priceCap: 10000, groups: ["korean"], radius: 900 };
    const opts = relaxOptions(tight);
    expect(opts.map((o) => o.label)).toEqual(["영업 중만 해제", "평점 무관", "예산 전체", "카테고리 전체", "반경 +300m"]);
    const by = (label: string) => opts.find((o) => o.label === label)!.apply(tight);
    expect(by("영업 중만 해제")).toEqual({ ...tight, openOnly: false });
    expect(by("평점 무관")).toEqual({ ...tight, minRating: 0 });
    expect(by("예산 전체")).toEqual({ ...tight, priceCap: "all" });
    expect(by("카테고리 전체")).toEqual({ ...tight, groups: [] });
    // 반경은 1000m에서 멈춘다
    expect(by("반경 +300m")).toEqual({ ...tight, radius: 1000 });
  });

  it("R21: 반경이 이미 1000m이고 다른 제약이 모두 꺼져 있으면 버튼이 없다 (다른 거점을 권한다)", () => {
    expect(relaxOptions({ ...DEFAULT_FILTERS, openOnly: false, radius: 1000 })).toEqual([]);
  });
});
