-- 앱 전역 상태 (key → value). place_blocked_until: 비공식 상세 API가 403/429를 준 뒤 호출을 멈출 시각(epoch ms)
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Cron이 만료된 상세 후보를 전체 스캔 없이 고르기 위한 인덱스 (R11).
-- status를 앞에 둬야 "ok는 3일 전, failed는 6시간 전" 두 범위를 각각 좁게 읽는다.
CREATE INDEX idx_places_status_fetched_at ON places(status, fetched_at);
