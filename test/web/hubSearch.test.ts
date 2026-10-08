import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Hub } from "../../shared/hubs";
import { HubPicker } from "../../web/components/HubPicker";
import { HubSearchField, noResultText } from "../../web/components/HubSearchField";
import { searchHubs } from "../../web/hubSearch";

// 화면 코드 원문 (Vite가 빌드 시점에 묶어 준다)
const sources = import.meta.glob("../../web/components/Hub{Chip,Picker}.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// 운영 거점 목록과 따로 고정한다 (공개·준비 중이 바뀌어도 규칙 테스트는 그대로). 가나다순, 호선은 web/hubLines.ts의 HUB_LINES
const hub = (id: string, name: string): Hub => ({ id, name, lat: 0, lng: 0, ready: true, refreshDay: 1 });
const HUBS: Hub[] = [
  hub("gangnam", "강남역"), // 2, 신분당
  hub("gwanghwamun", "광화문역"), // 5
  hub("naebang", "내방역"), // 7
  hub("ddp", "동대문역사문화공원역"), // 2, 4, 5
  hub("bongeunsa", "봉은사역"), // 9
  hub("seonjeongneung", "선정릉역"), // 9, 수인분당
  hub("yeoksam", "역삼역"), // 2
  hub("yeouido", "여의도역"), // 5, 9
  hub("gwacheon", "정부과천청사역"), // 4
  hub("pangyo", "판교역"), // 신분당, 경강
];
const ids = (q: string) => searchHubs(HUBS, q).map((h) => h.id);

describe("R24 역 검색 (searchHubs)", () => {
  it("R24: 빈 검색어(공백만 포함)는 모든 역을 그대로 돌려준다", () => {
    expect(searchHubs(HUBS, "")).toEqual(HUBS);
    expect(searchHubs(HUBS, "   ")).toEqual(HUBS);
    // 끝의 "역"을 떼면 빈 검색어 — 모든 역이 "역"이다
    expect(searchHubs(HUBS, "역")).toEqual(HUBS);
  });

  it("R24: 이름(끝의 '역' 뺀)에 검색어가 들어 있으면 찾는다 — 끝의 '역'·공백·대소문자는 무시", () => {
    expect(ids("강남")).toEqual(["gangnam"]);
    expect(ids("강남역")).toEqual(["gangnam"]);
    expect(ids(" 강 남 역 ")).toEqual(["gangnam"]);
    expect(ids("문화")).toEqual(["ddp"]);
    expect(ids("역사")).toEqual(["ddp"]); // 가운데 "역"은 이름의 일부
    expect(ids("역삼")).toEqual(["yeoksam"]);
    expect(ids("과천")).toEqual(["gwacheon"]);
    // 검색어 끝의 "역"도 뗀다 — "남역" → "남"
    expect(ids("남역")).toEqual(["gangnam"]);
    expect(ids("도역")).toEqual(["yeouido"]);
  });

  it("R24: 초성만 쓰면 이름(끝의 '역' 뺀)의 초성으로 찾는다 — 쌍자음 포함", () => {
    expect(ids("ㄱㄴ")).toEqual(["gangnam"]);
    expect(ids("ㅇㅇㄷ")).toEqual(["yeouido"]);
    expect(ids("ㄷㄷㅁ")).toEqual(["ddp"]);
    expect(ids("ㄱㅎ")).toEqual(["gwanghwamun"]);
    expect(ids("ㅇㅅ")).toEqual(["ddp", "bongeunsa", "yeoksam"]);
    expect(ids("ㅍㄱ")).toEqual(["pangyo"]);
    expect(ids("ㄱㄴ역")).toEqual(["gangnam"]);
    // 초성 문자열은 "역"을 뺀 이름에서 — 강남역의 ㅇ(역)은 없다
    expect(ids("ㄴㅇ")).toEqual([]);
    // 쌍자음도 초성 검색어다 (지금 거점에는 없어서 결과가 없다)
    expect(ids("ㄲ")).toEqual([]);
    expect(searchHubs([...HUBS, hub("kkachi", "까치산역")], "ㄲㅊ").map((h) => h.id)).toEqual(["kkachi"]);
    // 초성과 글자를 섞으면 초성 검색이 아니다
    expect(ids("강ㄴ")).toEqual([]);
  });

  it("R24: 호선 — 배지 이름('2', '신분당')이나 노선 이름('2호선', '신분당선')과 같으면 그 노선 역", () => {
    expect(ids("2")).toEqual(["gangnam", "ddp", "yeoksam"]);
    expect(ids("2호선")).toEqual(["gangnam", "ddp", "yeoksam"]);
    expect(ids("9")).toEqual(["bongeunsa", "seonjeongneung", "yeouido"]);
    expect(ids("신분당")).toEqual(["gangnam", "pangyo"]);
    expect(ids("신분당선")).toEqual(["gangnam", "pangyo"]);
    expect(ids("경강선")).toEqual(["pangyo"]);
    expect(ids("수인분당")).toEqual(["seonjeongneung"]);
    expect(ids("수인분당선")).toEqual(["seonjeongneung"]);
    // 노선 번호가 다르면 아니다
    expect(ids("3")).toEqual([]);
    expect(ids("3호선")).toEqual([]);
  });

  it("R24: 호선 — 노선 이름의 앞부분(2글자 이상)이면 그 노선 역", () => {
    expect(ids("신분")).toEqual(["gangnam", "pangyo"]);
    expect(ids("수인")).toEqual(["seonjeongneung"]);
    expect(ids("4호")).toEqual(["ddp", "gwacheon"]);
    expect(ids("경강")).toEqual(["pangyo"]);
    // 1글자는 노선 앞부분으로 치지 않는다 ("신" → 신분당선 아님, 이름에도 없음)
    expect(ids("신")).toEqual([]);
    // 노선 이름 가운데는 아니다
    expect(ids("분당")).toEqual([]);
  });

  it("R24: 맞는 역이 없으면 빈 목록", () => {
    expect(ids("서울")).toEqual([]);
    expect(ids("zzz")).toEqual([]);
    expect(ids("ㅋㅋ")).toEqual([]);
  });

  it("R24: 결과는 넘겨받은 순서(가나다순)를 그대로 지킨다", () => {
    // 이름·초성·호선 규칙이 섞여도 입력 순서
    expect(ids("5")).toEqual(["gwanghwamun", "ddp", "yeouido"]);
    const reversed = [...HUBS].reverse();
    expect(searchHubs(reversed, "5").map((h) => h.id)).toEqual(["yeouido", "ddp", "gwanghwamun"]);
    // 입력 배열은 바꾸지 않는다
    expect(HUBS.map((h) => h.id)[0]).toBe("gangnam");
  });
});

describe("R24 역 검색 — 화면 (헤더 메뉴·첫 접속 질문)", () => {
  const field = (value: string, count = 0) =>
    renderToStaticMarkup(createElement(HubSearchField, { value, count, onChange: () => {}, onEnter: () => {} }));

  it("R24: 검색 칸 — type=search, 안내 문구·이름표, 이동 키, 자동 완성·맞춤법 끔. 글자가 있을 때만 지우기", () => {
    const empty = field("");
    expect(empty).toMatch(/<input[^>]*type="search"/);
    expect(empty).toContain('placeholder="역 이름·호선 검색"');
    expect(empty).toContain('aria-label="역 검색"');
    expect(empty).toContain('enterKeyHint="go"');
    expect(empty).toContain('autoComplete="off"');
    expect(empty).toContain('spellCheck="false"');
    expect(empty).not.toContain('aria-label="지우기"');
    expect(field("강남", 1)).toContain('aria-label="지우기"');
  });

  it("R24: 결과 수는 읽기 도구에만 알린다 (polite) — 빈 검색어는 알리지 않고, 없으면 조용한 안내 문구", () => {
    expect(field("")).toMatch(/<span class="sr-only" aria-live="polite"><\/span>/);
    expect(field("2", 3)).toContain(">결과 3곳<");
    expect(noResultText(" 서울 ")).toBe("‘서울’ 역은 아직 없어요");
    expect(field(" 서울 ", 0)).toContain(">‘서울’ 역은 아직 없어요<");
  });

  it("R61: 첫 접속 질문은 제목 아래 검색 칸, 그 아래 역 목록", () => {
    const html = renderToStaticMarkup(createElement(HubPicker, { onPick: () => {}, onDismiss: () => {} }));
    expect(html).toContain('placeholder="역 이름·호선 검색"');
    expect(html).toContain('aria-label="역 검색"');
    const at = (s: string) => html.indexOf(s);
    expect(at('id="picker-title"')).toBeLessThan(at('aria-label="역 검색"'));
    expect(at('aria-label="역 검색"')).toBeLessThan(at('class="picker-list"'));
  });

  it("R24: 헤더 메뉴(대화 상자)와 첫 접속 질문 모두 같은 검색 칸으로 공개 거점 가나다순 목록을 거른다", () => {
    for (const p of ["../../web/components/HubChip.tsx", "../../web/components/HubPicker.tsx"]) {
      expect(sources[p], p).toMatch(/<HubSearchField\b/);
      expect(sources[p], p).toMatch(/searchHubs\(pickerHubs\(\), query\)/);
    }
    // 글자 입력칸이 들어가므로 메뉴(role="menu")가 아니라 대화 상자
    expect(sources["../../web/components/HubChip.tsx"]).not.toMatch(/role="menu/);
    expect(sources["../../web/components/HubChip.tsx"]).toMatch(/role="dialog"/);
  });
});
