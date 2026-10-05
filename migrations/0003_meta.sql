-- 앱 전역 상태 (key → value). place_blocked_until: 비공식 상세 API가 403/429를 준 뒤 호출을 멈출 시각(epoch ms)
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
