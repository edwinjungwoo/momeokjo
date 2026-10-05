/**
 * R19 인원 휴리스틱의 기준. 서버(목록 응답의 불리언 계산)와 브라우저가 이 한 곳만 쓴다.
 * 주의: 목록 원소 출력이 바뀌므로 여기를 바꾸면 LIST_JSON_VERSION(shared/constants.ts)을 올린다 — 저장된 places.list_json 조각에 결과가 들어 있다.
 */
export const SOLO_KEYWORDS = ["국밥", "해장국", "라멘", "라면", "분식", "덮밥", "돈까스", "우동", "국수", "김밥", "패스트푸드"];
export const GROUP_TAGS = ["단체석", "회식장소", "모임맛집"];

export const soloFriendly = (category: string, tags: string[]) =>
  SOLO_KEYWORDS.some((k) => category.includes(k)) || tags.includes("혼밥");
export const groupFriendly = (tags: string[]) => tags.some((t) => GROUP_TAGS.includes(t));
