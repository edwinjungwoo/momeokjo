/**
 * R24 거점("Pin"). 거점을 늘리려면 이 배열에 한 줄만 더하면 된다 —
 * 화면의 거점 메뉴, 설정·공유 링크 검증, Cron 사전 수집(R11)이 모두 이 목록을 쓴다.
 */
export type Hub = { id: string; name: string; lat: number; lng: number };

export const HUBS: Hub[] = [
  { id: "bongeunsa", name: "봉은사역", lat: 37.514255, lng: 127.060234 },
  { id: "ddp", name: "동대문역사문화공원역", lat: 37.5651, lng: 127.00749 },
  // 신분당선·경강선 출구 사이
  { id: "pangyo", name: "판교역", lat: 37.394777, lng: 127.11159 },
  { id: "naebang", name: "내방역", lat: 37.487659, lng: 126.9936 },
  { id: "gwacheon", name: "정부과천청사역", lat: 37.426505, lng: 126.989868 },
];

export const DEFAULT_HUB_ID = "bongeunsa";

export const isHubId = (id: string | null | undefined): id is string => HUBS.some((h) => h.id === id);

/** 모르는 id나 빈 값이면 기본 거점 */
export function hubById(id: string | null | undefined): Hub {
  return HUBS.find((h) => h.id === id) ?? HUBS.find((h) => h.id === DEFAULT_HUB_ID) ?? HUBS[0];
}
