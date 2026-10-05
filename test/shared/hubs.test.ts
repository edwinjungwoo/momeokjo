import { describe, expect, it } from "vitest";
import { DEFAULT_HUB_ID, HUBS, hubById, isHubId } from "../../shared/hubs";

describe("hubs", () => {
  it("R24: 거점은 봉은사역(기본), 동대문역사문화공원역, 판교역, 내방역, 정부과천청사역", () => {
    expect(HUBS).toEqual([
      { id: "bongeunsa", name: "봉은사역", lat: 37.514255, lng: 127.060234 },
      { id: "ddp", name: "동대문역사문화공원역", lat: 37.5651, lng: 127.00749 },
      { id: "pangyo", name: "판교역", lat: 37.394777, lng: 127.11159 },
      { id: "naebang", name: "내방역", lat: 37.487659, lng: 126.9936 },
      { id: "gwacheon", name: "정부과천청사역", lat: 37.426505, lng: 126.989868 },
    ]);
    expect(DEFAULT_HUB_ID).toBe("bongeunsa");
    expect(new Set(HUBS.map((h) => h.id)).size).toBe(HUBS.length);
  });
  it("R24: id로 찾고, 모르는 id나 빈 값이면 기본 거점", () => {
    expect(hubById("ddp").name).toBe("동대문역사문화공원역");
    expect(hubById("gangnam").id).toBe("bongeunsa");
    expect(hubById(null).id).toBe("bongeunsa");
    expect(isHubId("ddp")).toBe(true);
    expect(isHubId("gangnam")).toBe(false);
  });
});
