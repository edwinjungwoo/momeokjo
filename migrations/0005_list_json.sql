-- 목록(R12) 원소를 미리 직렬화해 둔 JSON (거리·도보 분 없음). 상세를 저장할 때 같이 쓰고, 목록은 JSON 열 4개를 다시 읽지 않고 이어 붙인다.
-- NULL이면(이 마이그레이션 전에 저장된 행) 예전처럼 열에서 만든다. Cron이 조금씩 채운다 (worker/repo.ts backfillListJson)
ALTER TABLE places ADD COLUMN list_json TEXT;
