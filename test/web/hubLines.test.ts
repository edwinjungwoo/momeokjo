import { describe, expect, it } from "vitest";
import { HUBS, PUBLIC_HUBS } from "../../shared/hubs";
import { HUB_LINES, LINES, pickerHubs } from "../../web/hubLines";

describe("역 고르기 — 호선 배지·가나다순", () => {
  it("모든 거점에 호선이 하나 이상 있고, 모두 아는 노선이다", () => {
    for (const h of HUBS) {
      const lines = HUB_LINES[h.id];
      expect(lines?.length, h.id).toBeGreaterThan(0);
      for (const l of lines ?? []) expect(LINES[l], `${h.id} ${l}`).toBeDefined();
    }
  });

  it("역마다 호선 (2026-10 기준 운행 노선)", () => {
    expect(HUB_LINES).toMatchObject({
      bongeunsa: ["9"],
      ddp: ["2", "4", "5"],
      pangyo: ["sinbundang", "gyeonggang"],
      naebang: ["7"],
      gwacheon: ["4"],
      gangnam: ["2", "sinbundang"],
      yeouido: ["5", "9"],
      gwanghwamun: ["5"],
      yeoksam: ["2"],
      seonjeongneung: ["9", "suinbundang"],
      seolleung: ["2", "suinbundang"],
      samseong: ["2"],
      cityhall: ["1", "2"],
      euljiro1ga: ["2"],
    });
  });

  it("노선 색은 서울 지하철 노선도 색, 숫자 노선은 숫자·이름 노선은 짧은 이름", () => {
    expect(LINES["2"]).toEqual({ label: "2", name: "2호선", color: "#00A84D" });
    expect(LINES["9"]).toEqual({ label: "9", name: "9호선", color: "#BDB092" });
    expect(LINES.sinbundang).toEqual({ label: "신분당", name: "신분당선", color: "#D4003B" });
    expect(LINES.gyeonggang).toEqual({ label: "경강", name: "경강선", color: "#0054A6" });
  });

  it("고르기 목록은 공개 거점을 가나다순으로", () => {
    const names = pickerHubs().map((h) => h.name);
    expect(names).toEqual(["강남역", "광화문역", "내방역", "동대문역사문화공원역", "봉은사역", "삼성역", "선릉역", "선정릉역", "여의도역", "역삼역", "정부과천청사역", "판교역"]);
    expect(pickerHubs()).toHaveLength(PUBLIC_HUBS.length);
  });
});
