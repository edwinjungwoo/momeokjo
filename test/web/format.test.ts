import { describe, expect, it } from "vitest";
import type { PlacesResponse } from "../../shared/types";
import { MENU_PREVIEW, RATING_HIGH, callFirst, menuPreview, ratingTone, refreshNote, rowSubLine, telHref } from "../../web/format";
import { apiPlace } from "../helpers/apiPlace";

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
