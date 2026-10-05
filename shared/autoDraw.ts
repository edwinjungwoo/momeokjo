/**
 * R39 열자마자 3곳: 재방문자는 목록이 오면 한 번 자동으로 뽑는다.
 * 첫 방문, 공유 링크, 이번 탭 세션에 이미 자동으로 뽑음, 사용자가 이미 무언가 누름, 오늘 끔, 목록 전, 후보 0곳이면 하지 않는다.
 * 목록이 아직 채워지는 중(pending 폴링 중)이면 기다리되, 조건 맞는 후보가 이미 충분하거나(30곳) 폴링이 5초를 넘으면
 * 그때까지 온 목록으로 뽑는다 (거점의 pending이 끝내 줄지 않으면 30초를 기다리게 되던 것, QA P2).
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
  /** 거점 목록이 다 왔음 (pending 폴링이 끝났거나 처음부터 다 찬 응답, 또는 24시간 안의 기기 저장본) */
  settled: boolean;
  /** 뽑을 수 있는 후보 수 (R41 완화 포함) */
  pool: number;
  /** 새로 받은 목록을 pending 때문에 다시 부르는 중 (하루 넘은 기기 저장본만 있을 때는 false) */
  polling: boolean;
  /** 지금 반경에서 조건에 맞는 후보 수 (완화 전) */
  strict: number;
  /** 폴링을 시작한 뒤 지난 시간(ms) */
  pollingMs: number;
};

/** 폴링 중이어도 조건 맞는 후보가 이만큼이면 바로 뽑는다 */
export const AUTO_DRAW_ENOUGH = 30;
/** 폴링이 이만큼 이어지면 후보가 적어도 뽑는다 */
export const AUTO_DRAW_POLL_WAIT_MS = 5000;

export function shouldAutoDraw(x: AutoDrawInput): boolean {
  const ready = x.settled || (x.polling && (x.strict >= AUTO_DRAW_ENOUGH || x.pollingMs >= AUTO_DRAW_POLL_WAIT_MS));
  return (
    x.returning && !x.shareLink && !x.drawnThisSession && !x.interacted && x.offDay !== x.today && x.hasData && ready &&
    x.pool > 0
  );
}

/**
 * 폴링을 시작한 뒤 지난 시간. 5초 타이머가 이미 울렸으면(waited) 시계로 재지 않고 대기를 다 채운 것으로 본다 —
 * 타이머가 Date.now() 차이보다 몇 ms 일찍 울리면 4,99x ms로 재져서 그 뒤로 다시 판단할 기회가 없었다
 */
export function pollingElapsed(waited: boolean, start: number | null, now: number): number {
  if (waited) return AUTO_DRAW_POLL_WAIT_MS;
  return start === null ? 0 : now - start;
}
