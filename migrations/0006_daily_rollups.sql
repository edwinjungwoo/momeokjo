-- R54 관리자 대시보드용 일별 집계. 30·90일 화면이 events를 매번 훑지 않게 Cron이 KST 하루에 한 번 전날을 집계해 둔다.
-- hub = 거점 id 또는 '*'(모든 거점). 값이 0인 지표는 쓰지 않는다(없으면 0). 지표 이름과 정의는 shared/dashboard.ts(METRICS)와 스펙 R53.
-- 코호트(R53 재방문)는 day = 첫 방문 주의 월요일(KST), metric = cohort_* 행으로 같은 표에 둔다.
-- WITHOUT ROWID: 기본 키가 곧 표라서 한 행을 쓸 때 인덱스 행을 따로 쓰지 않는다 (쓰기 행 수 절반)
CREATE TABLE daily_stats (
  day TEXT NOT NULL,
  hub TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (day, hub, metric)
) WITHOUT ROWID;

-- R53 재방문 코호트: 익명 id마다 첫 방문일(KST)과 그날 처음 연 거점, 재방문 비트(ret: 1=D1, 2=D7, 4=D14, 8=D28 — 첫 방문일 + n일 이후에 다시 앱을 엶),
-- 마지막으로 앱을 연 날(last_day). Cron 집계만 쓴다(이벤트 수집 경로는 건드리지 않음). last_day가 90일 지나면 지운다 (R35 보관 기간과 같게)
CREATE TABLE anon_first_seen (
  anon TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  hub TEXT NOT NULL,
  ret INTEGER NOT NULL DEFAULT 0,
  last_day TEXT NOT NULL
) WITHOUT ROWID;
