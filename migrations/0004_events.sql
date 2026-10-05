-- R35 익명 사용 이벤트. IP·User-Agent·위치·자유 입력은 저장하지 않는다. 90일 뒤 Cron이 지운다.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,          -- 서버가 확인한 epoch ms
  day TEXT NOT NULL,            -- KST yyyy-mm-dd (GROUP BY를 싸게 하려고 미리 계산)
  hour INTEGER NOT NULL,        -- KST 0–23
  anon TEXT NOT NULL,           -- 브라우저마다 무작위 id (localStorage)
  session TEXT NOT NULL,        -- 탭 세션 id (30분 무활동이면 새로)
  hub TEXT NOT NULL,
  type TEXT NOT NULL,
  place_id TEXT,
  props TEXT                    -- 검증한 props의 짧은 JSON
);
CREATE INDEX idx_events_day ON events(day);
CREATE INDEX idx_events_type_day ON events(type, day);
