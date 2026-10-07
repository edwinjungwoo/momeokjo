/** 시트가 거의 다 덮어도 지도 컨테이너에 남기는 높이(px). 카카오 로고·축척 한 줄(약 20px)과 여백이 들어간다 */
export const MIN_MAP_VISIBLE = 40;

/**
 * R28: 모바일 바텀 시트(fixed)가 지도 칸 아래쪽을 덮는 높이(px). 지도 컨테이너를 그만큼 줄이면
 * 카카오 로고·축척(약관상 가리면 안 된다)이 시트 바로 위에 보인다.
 * wrap은 지도 칸(.map-wrap)의 화면 위치, sheetTop은 시트 윗변(움직임 transform을 뺀 자리). 시트가 없으면 null
 */
export function sheetCover(wrap: { top: number; bottom: number }, sheetTop: number | null): number {
  if (sheetTop === null) return 0;
  const cover = Math.round(wrap.bottom - sheetTop);
  if (cover <= 0) return 0;
  return Math.min(cover, Math.max(0, Math.round(wrap.bottom - wrap.top) - MIN_MAP_VISIBLE));
}

/** R28: 로고·축척 자리 (kakao.maps.CopyrightPosition 이름). 데스크톱은 결과 오버레이가 지도 왼쪽 아래를 덮는다 */
export const copyrightCorner = (desktop: boolean): "BOTTOMLEFT" | "BOTTOMRIGHT" => (desktop ? "BOTTOMRIGHT" : "BOTTOMLEFT");

/** 지도가 마지막으로 스스로 한 이동: 핀으로 panTo, 뽑힌 3곳 맞추기(setBounds) */
export type MapOp = "pan" | "fit" | null;
export type CoverFollow = { kind: "pan"; id: string } | { kind: "fit" } | { kind: "anchor" };

/**
 * R28: 지도 높이(--map-cover)를 바꾼 뒤 지도 가운데를 어떻게 둘지.
 * 높이를 바꾸기 전에 잰 가운데로 setCenter하면 진행 중인 panTo(목록·핀 선택, 후보 펼침)를 끊어서 지도가 선택한 핀을 따라가지 못한다.
 * - 따라갈 핀(선택한 핀, 없으면 펼친 후보)이 있으면 그 핀으로 다시 이동
 * - 없고 마지막 동작이 3곳 맞추기면 새 높이로 다시 맞추기
 * - 사용자가 끌었거나 따라가던 곳이 없으면 지도 내용을 제자리에 둔다(위쪽 기준)
 */
export function coverFollow(s: { panId: string | null; lastOp: MapOp; moved: boolean }): CoverFollow {
  if (s.moved) return { kind: "anchor" };
  if (s.panId) return { kind: "pan", id: s.panId };
  if (s.lastOp === "fit") return { kind: "fit" };
  return { kind: "anchor" };
}
