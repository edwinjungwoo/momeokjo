import { describe, expect, it } from "vitest";
import type { PlacesResponse } from "../../shared/types";
import { callFirst, refreshNote, telHref } from "../../web/format";
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

describe("R63 가게 정보 업데이트 한 줄", () => {
  const KST = 9 * 3600_000;
  const base = {
    center: { lat: 37.5, lng: 127 }, radius: 1000, places: [], pending: 0, incompleteTiles: 0, stale: false, detailsPaused: false,
    detailsFrozenSince: null, detailsNewestAt: null, refreshedAt: null, refreshDay: 1,
  } as PlacesResponse;

  it("R63: 마지막 완료 날짜(KST)와 갱신 요일, 완료한 적이 없으면 요일만 — 목록이 없으면 보이지 않는다", () => {
    const at = Date.UTC(2026, 9, 5, 14, 30) - KST; // 10월 5일(월) 14:30 KST
    expect(refreshNote({ ...base, refreshedAt: at }, 2)).toBe("가게 정보 10월 5일(월) 업데이트 · 매주 월요일");
    expect(refreshNote(base, 2)).toBe("매주 월요일 업데이트");
    expect(refreshNote(null, 1)).toBeNull();
  });

  it("R63: 예전 기기 저장본(필드 없음)은 거점 설정의 요일로, 완료 날짜 없이 보여준다", () => {
    const { refreshedAt: _a, refreshDay: _d, ...old } = base;
    expect(refreshNote(old as PlacesResponse, 4)).toBe("매주 목요일 업데이트");
  });
});
