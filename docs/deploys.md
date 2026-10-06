# 배포 기록

`npm run release`(scripts/deploy.mjs)가 운영을 바꿀 때마다 한 줄씩 더해요. 커밋은 운영자가 해요 (docs/deploy.md).

| 날짜 (KST) | 버전 | 커밋 | 마이그레이션 | 결과 | 롤백 대상 |
|---|---|---|---|---|---|
| 2026-10-06 09:24 | 72a9f970 | 3a4cc93 | 0003_meta, 0004_events, 0005_list_json | 성공 (손으로, 런북) | 2f5adde0 |
| 2026-10-06 11:26 | 6a5d3051 | 8d0bf6b | 0006_daily_rollups, 0007_hub_snapshots | 성공 | 72a9f970 |
| 2026-10-06 14:43 | 6eeb6e06 | 9348f1b | - | 성공 | 6a5d3051 |
| 2026-10-06 16:19 | f559fcf2 | 62c2cb5 | - | 롤백 (새 FAIL 3) — 둘째 트리거를 2-59/5로 되돌려야 해요 (대시보드 Triggers 또는 wrangler triggers deploy) | 6eeb6e06 |
