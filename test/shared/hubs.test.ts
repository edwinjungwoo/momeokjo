import { describe, expect, it } from "vitest";
import { PREWARM_RADIUS } from "../../shared/constants";
import { tilesCoveringCircle } from "../../shared/geo";
import { DEFAULT_HUB_ID, HUBS, PUBLIC_HUBS, hubById, isHubId, isPublicHubId, publicHubById } from "../../shared/hubs";

describe("hubs", () => {
  it("R24: 거점은 봉은사역(기본), 동대문역사문화공원역, 판교역, 내방역, 정부과천청사역, 강남역, 여의도역, 광화문역", () => {
    expect(HUBS).toEqual([
      { id: "bongeunsa", name: "봉은사역", lat: 37.514255, lng: 127.060234, ready: true, refreshDay: 1 },
      { id: "ddp", name: "동대문역사문화공원역", lat: 37.5651, lng: 127.00749, ready: true, refreshDay: 2 },
      { id: "pangyo", name: "판교역", lat: 37.394777, lng: 127.11159, ready: true, refreshDay: 3 },
      { id: "naebang", name: "내방역", lat: 37.487659, lng: 126.9936, ready: true, refreshDay: 3 },
      { id: "gwacheon", name: "정부과천청사역", lat: 37.426505, lng: 126.989868, ready: true, refreshDay: 4 },
      { id: "gangnam", name: "강남역", lat: 37.498086, lng: 127.028001, ready: false, refreshDay: 5 },
      { id: "yeouido", name: "여의도역", lat: 37.521775, lng: 126.924398, ready: false, refreshDay: 6 },
      { id: "gwanghwamun", name: "광화문역", lat: 37.571649, lng: 126.976424, ready: false, refreshDay: 4 },
    ]);
    expect(DEFAULT_HUB_ID).toBe("bongeunsa");
    expect(new Set(HUBS.map((h) => h.id)).size).toBe(HUBS.length);
  });
  it("R24: id로 찾고, 모르는 id나 빈 값이면 기본 거점", () => {
    expect(hubById("ddp").name).toBe("동대문역사문화공원역");
    expect(hubById("atlantis").id).toBe("bongeunsa");
    expect(hubById(null).id).toBe("bongeunsa");
    expect(isHubId("ddp")).toBe(true);
    expect(isHubId("atlantis")).toBe(false);
  });

  it("R62: 공개 거점은 ready인 5곳뿐이고, 새로 더한 3곳(강남역·여의도역·광화문역)은 준비 중이다", () => {
    expect(PUBLIC_HUBS.map((h) => h.id)).toEqual(["bongeunsa", "ddp", "pangyo", "naebang", "gwacheon"]);
    expect(HUBS.filter((h) => !h.ready).map((h) => h.id)).toEqual(["gangnam", "yeouido", "gwanghwamun"]);
    // 기본 거점은 언제나 공개 거점이어야 한다 (저장값·링크가 틀리면 여기로 간다)
    expect(PUBLIC_HUBS.some((h) => h.id === DEFAULT_HUB_ID)).toBe(true);
  });

  it("R62: 화면용 검증(isPublicHubId·publicHubById)은 준비 중 거점을 모르는 거점처럼, 배경 작업용(isHubId·hubById)은 모든 거점", () => {
    expect(isPublicHubId("ddp")).toBe(true);
    for (const id of ["gangnam", "yeouido", "gwanghwamun", "atlantis", null, undefined, ""]) expect(isPublicHubId(id), String(id)).toBe(false);
    expect(publicHubById("pangyo").id).toBe("pangyo");
    expect(publicHubById("gangnam").id).toBe("bongeunsa");
    expect(publicHubById(null).id).toBe("bongeunsa");
    expect(isHubId("gangnam")).toBe(true);
    expect(hubById("gangnam").name).toBe("강남역");
  });

  it("R24/R43: 거점 id는 URL 경로에 그대로 쓰는 소문자 영숫자(·하이픈)이고 서로 다르다", () => {
    for (const h of HUBS) expect(h.id, h.id).toMatch(/^[a-z0-9-]+$/);
    expect(new Set(HUBS.map((h) => h.id)).size).toBe(HUBS.length);
  });

  it("R24/R11: 모든 거점의 1000m 격자를 격자마다 3쪽씩 불러도 일주일 Cron 예산(5분마다 40회)의 10% 안이다", () => {
    const tiles = new Set(HUBS.flatMap((h) => tilesCoveringCircle(h, PREWARM_RADIUS))).size;
    const weeklyBudget = ((24 * 60) / 5) * 7 * 40;
    expect(tiles).toBeGreaterThan(0);
    expect(tiles * 3).toBeLessThan(weeklyBudget * 0.1);
  });
});
