-- R66 적응형 상세 갱신 (바뀌는 만큼만). 가게마다 갱신 주기와 표시 정보 지문, 다음 갱신 기준 시각을 둔다.
-- interval_weeks: 1·2·4만. 상세를 저장할 때 지문(fp)이 지난번과 같으면 두 배(최대 4), 다르거나 처음이면 1. 실패(R9)는 바꾸지 않는다.
-- fp: 화면에 보이는 상세의 지문 (shared/adaptiveRefresh.ts detailFingerprint — 리뷰 수·사진 제외). NULL = 아직 없음(처음처럼 1주).
-- due_after = fetched_at + (interval_weeks − 1) × 7일. R63 거점 갱신 시작보다 이르면 갱신 대상 (예전 fetched_at 자리).
--   NULL(이 마이그레이션 뒤·배포 전에 옛 코드가 쓴 행)은 fetched_at으로 본다. 옛 코드는 세 열을 모르고 모두 매주 갱신한다(롤백해도 안전).
ALTER TABLE places ADD COLUMN interval_weeks INTEGER NOT NULL DEFAULT 1;
ALTER TABLE places ADD COLUMN fp TEXT;
ALTER TABLE places ADD COLUMN due_after INTEGER;
-- 지금 행은 모두 주기 1 — 대상 판단이 예전(fetched_at)과 같다
UPDATE places SET due_after = fetched_at;
-- Cron 만료 후보(R11): ok는 (status, due_after)를 오래된 순으로 범위만 읽는다 (failed는 그대로 idx_places_status_fetched_at)
CREATE INDEX idx_places_status_due ON places(status, due_after);
