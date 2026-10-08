import { PUBLIC_HUBS, type Hub } from "../shared/hubs";

/** 역 고르기 화면의 호선 배지 — 색은 서울 지하철 노선도 색. 화면에서만 쓴다 (서버·스모크가 읽는 shared/hubs.ts는 그대로) */
export type Line = { label: string; name: string; color: string };

export const LINES: Record<string, Line> = {
  "2": { label: "2", name: "2호선", color: "#00A84D" },
  "4": { label: "4", name: "4호선", color: "#00A5DE" },
  "5": { label: "5", name: "5호선", color: "#996CAC" },
  "7": { label: "7", name: "7호선", color: "#747F00" },
  "9": { label: "9", name: "9호선", color: "#BDB092" },
  sinbundang: { label: "신분당", name: "신분당선", color: "#D4003B" },
  gyeonggang: { label: "경강", name: "경강선", color: "#0054A6" },
};

/** 거점 id → 지나는 노선 (2026-10 기준 운행 노선, 노선 번호순) */
export const HUB_LINES: Record<string, string[]> = {
  bongeunsa: ["9"],
  ddp: ["2", "4", "5"],
  pangyo: ["sinbundang", "gyeonggang"],
  naebang: ["7"],
  gwacheon: ["4"],
  gangnam: ["2", "sinbundang"],
  yeouido: ["5", "9"],
  gwanghwamun: ["5"],
};

/** 역 고르기 목록 (헤더 메뉴·첫 접속 질문): 공개 거점을 가나다순으로 */
export const pickerHubs = (): Hub[] => [...PUBLIC_HUBS].sort((a, b) => a.name.localeCompare(b.name, "ko"));

export const hubLines = (id: string): Line[] => (HUB_LINES[id] ?? []).flatMap((l) => (LINES[l] ? [LINES[l]] : []));
