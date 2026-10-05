import { describe, expect, it } from "vitest";
import { callFirst, telHref } from "../../web/format";
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
