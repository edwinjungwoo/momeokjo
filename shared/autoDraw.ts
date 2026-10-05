/**
 * R39 열자마자 3곳: 재방문자는 목록이 오면 한 번 자동으로 뽑는다.
 * 첫 방문, 공유 링크, 이번 탭 세션에 이미 자동으로 뽑음, 사용자가 이미 무언가 누름, 오늘 끔, 목록 전, 후보 0곳이면 하지 않는다.
 */
export type AutoDrawInput = {
  /** 첫 방문 안내를 닫았거나 R37 신호가 있음 */
  returning: boolean;
  /** 공유 링크(t·p)로 열었음 */
  shareLink: boolean;
  drawnThisSession: boolean;
  interacted: boolean;
  /** 자동 뽑기를 끈 날(KST yyyy-mm-dd) */
  offDay: string | null;
  today: string;
  hasData: boolean;
  /** 뽑을 수 있는 후보 수 (R41 완화 포함) */
  pool: number;
};

export function shouldAutoDraw(x: AutoDrawInput): boolean {
  return (
    x.returning && !x.shareLink && !x.drawnThisSession && !x.interacted && x.offDay !== x.today && x.hasData && x.pool > 0
  );
}
