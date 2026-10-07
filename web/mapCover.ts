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
