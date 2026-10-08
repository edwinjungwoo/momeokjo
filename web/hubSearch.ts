import type { Hub } from "../shared/hubs";
import { hubLines } from "./hubLines";

/** 비교용: 공백을 모두 빼고 소문자로 */
const normalize = (s: string) => s.replace(/\s+/g, "").toLowerCase();
/** 끝의 "역"을 뗀다 ("강남역" → "강남") */
const dropStation = (s: string) => s.replace(/역$/, "");

// 한글 음절의 첫소리(초성) 19자 — 유니코드 음절 순서
const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
/** 한글 호환 자모의 자음만으로 된 검색어 (ㄱ~ㅎ, 쌍자음·겹자음 포함) */
const CONSONANTS_ONLY = /^[ㄱ-ㅎ]+$/;

/** 음절은 초성으로, 그 밖의 글자는 그대로 ("강남" → "ㄱㄴ") */
const initials = (s: string) =>
  [...s]
    .map((ch) => {
      const code = ch.charCodeAt(0) - 0xac00;
      return code >= 0 && code < 11172 ? INITIALS[Math.floor(code / 588)] : ch;
    })
    .join("");

/**
 * R24: 역 고르기(헤더 메뉴·첫 접속 질문)의 역 검색. 넘겨받은 순서(가나다순)를 그대로 지키고, 빈 검색어면 모두.
 * 검색어는 공백을 빼고 소문자로, 끝의 "역"은 뗀다. 다음 중 하나라도 맞으면 그 역:
 * - 이름(끝의 "역" 뺀)에 검색어가 들어 있다 ("강남" → 강남역, "문화" → 동대문역사문화공원역)
 * - 검색어가 자음만이고 이름(끝의 "역" 뺀)의 초성에 들어 있다 ("ㄱㄴ" → 강남역)
 * - 지나는 노선의 배지 이름·노선 이름과 같거나("2", "2호선", "신분당"), 2글자 이상으로 노선 이름 앞부분이다("신분" → 신분당선)
 */
export function searchHubs(hubs: Hub[], query: string): Hub[] {
  const q = dropStation(normalize(query));
  if (q === "") return hubs;
  const consonants = CONSONANTS_ONLY.test(q);
  return hubs.filter((h) => {
    const name = dropStation(normalize(h.name));
    if (name.includes(q)) return true;
    if (consonants && initials(name).includes(q)) return true;
    return hubLines(h.id).some((l) => {
      const label = normalize(l.label);
      const lineName = normalize(l.name);
      return q === label || q === lineName || (q.length >= 2 && lineName.startsWith(q));
    });
  });
}
