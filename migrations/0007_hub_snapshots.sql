-- R56 거점 스냅샷: Cron이 만든 거점 1000m 목록 응답 본문(/api/places와 글자까지 같음)을 gzip해서 base64로 둔다 (worker/hubSnapshot.ts).
-- 엣지 캐시가 빈 요청은 이 한 행만 읽어 답한다. version은 HUB_SNAPSHOT_VERSION, source_at은 만들기 전에 읽은 거점 표시(meta snapshot_dirty:{hub}),
-- etag는 본문에서 정한 ETag(따옴표 포함). body는 base64 텍스트다 — D1은 BLOB을 숫자 배열로 돌려줘서 읽는 쪽 CPU가 더 든다.
-- (0006은 feat/admin-ops가 쓴다)
CREATE TABLE hub_snapshots (
  hub TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  built_at INTEGER NOT NULL,
  source_at INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  etag TEXT NOT NULL,
  body TEXT NOT NULL
);
