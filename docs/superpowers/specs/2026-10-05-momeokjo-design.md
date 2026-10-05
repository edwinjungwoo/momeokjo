# 모먹죠 (mmj.itmz.me) 설계 스펙

- 작성일: 2026-10-05
- 상태: 리뷰 대기
- 형태: 하루짜리 해커톤 프로젝트, 완전 공개 웹앱

## 1. 개요

선약 없는 평일 점심, 점심시간 5~10분 전에 "점심 ㄱ?" "ㅇㅇ"로 즉석에서 꾸려진 일행이 **어디 갈지 1분 안에 정하도록** 돕는 지도 + 큐레이션 앱.

- 기본 기준점은 서울 삼성동 ASEM 타워. 누구나 "내 위치"나 "지도에서 찍기"로 기준점을 바꿀 수 있다.
- 점심시간 길이(30/60/90분), 인원, 카테고리, 1인 예산, 평점, 영업 여부로 후보를 좁히고 "모먹죠?" 버튼으로 가중 랜덤 뽑기를 한다.
- 데이터는 카카오 로컬 API(공식)와 카카오맵 장소 상세(비공식)를 쓴다.

### 개발 원칙

- **데이터가 최우선이다.** 데이터 파이프라인을 먼저 만들고, 데이터 품질 수용 기준(§7)을 통과한 뒤에 UI를 만든다.
- **SDD:** 이 문서가 기준이다. 요구사항은 `R*`(기능), `Q*`(데이터 품질) 번호로 추적한다. 구현하다가 스펙과 다른 판단이 필요하면 스펙을 먼저 고친다.
- **TDD:** 모든 `R*`는 실패하는 테스트로 시작한다. 테스트 이름은 요구사항 번호로 시작한다(예: `R7: 전골(중) 67,000원은 대표가격 계산에서 제외`).

### 확정된 결정

| 항목 | 결정 |
|---|---|
| 이름 / 도메인 | 모먹죠 / `mmj.itmz.me` (itmz.me는 Cloudflare 존, 확인 완료) |
| 접근 제한 | 없음 (완전 공개) |
| 기준점 | 기본 ASEM 타워, 내 위치 / 지도 클릭으로 변경 가능 |
| 런타임 | Cloudflare Worker 1개 (정적 에셋 + Hono API) + D1 + Cron Trigger |
| 프론트엔드 | React + Vite + TypeScript, 카카오맵 JS SDK |
| 테스트 | Vitest, `@cloudflare/vitest-pool-workers`, zod |
| 디자인 | 깔끔 미니멀, 포인트 컬러 오렌지/코랄, 라이트 모드만 |
| 뽑기 연출 | 약 0.8초 슬롯 셔플 후 지도 이동 |
| 기본 필터 | 60분 · 2명 · 카테고리 전체 · 평점 무관 · 영업 중만 ON · 술집 제외 |

### 범위 밖 (이번 하루에는 하지 않음)

익명 사내 추천(2단계), 로그인/인증, 다크 모드, E2E 테스트, UI 렌더링 테스트, 다국어.

## 2. 아키텍처

```
[브라우저 React SPA]
  │  GET /api/places?lat&lng&radius        GET /api/places/:id
  ▼
[Worker: Hono]
  ├─ 정적 에셋 (Vite 빌드 결과)
  ├─ PlacesService ── TileCollector ──▶ 카카오 로컬 API (공식, REST 키)
  │                └─ DetailEnricher ─▶ 카카오맵 장소 상세 (비공식)
  ├─ D1: places, place_details, tiles
  └─ scheduled(): ASEM 반경 1.5km 사전 수집

필터링, 정렬, 뽑기는 전부 브라우저에서 한다 (반경 내 가게는 수백 곳 이하라 전송 가능).
```

### 모듈 경계

각 모듈은 순수 함수 또는 의존성 주입(fetch, DB, 시계, 난수)으로 테스트할 수 있게 만든다.

| 모듈 | 위치 | 책임 | 의존 |
|---|---|---|---|
| `geo` | `shared/` | 격자 키, 사각형, 하버사인 거리, 원을 덮는 격자 목록, 도보 시간 | 없음 (순수) |
| `category` | `shared/` | 카카오 카테고리 문자열 → 그룹 매핑 | 없음 (순수) |
| `detailParser` | `worker/` | 비공식 응답(zod 검증) → `PlaceDetail` | zod |
| `price` | `shared/` | 메뉴 → 대표 가격 | 없음 (순수) |
| `hours` | `shared/` | 영업시간 → 특정 시각 영업 여부 | 없음 (순수) |
| `kakaoLocal` | `worker/` | 공식 API 클라이언트 + 응답 파싱 | fetch 주입 |
| `kakaoPlace` | `worker/` | 비공식 API 클라이언트 | fetch 주입 |
| `TileCollector` | `worker/` | 격자 수집, 쿼드트리 분할, 예산 관리 | kakaoLocal, repo, clock |
| `DetailEnricher` | `worker/` | 상세 보충 배치, 재시도, 실패 기록 | kakaoPlace, repo, clock |
| `repo` | `worker/` | D1 읽기/쓰기 | D1 |
| `recommend` | `shared/` | 필터, 정렬, 인원 휴리스틱, 가중치, 뽑기 | rng 주입 |
| `share` | `shared/` | 공유 텍스트와 URL 직렬화/역직렬화 | 없음 (순수) |

`shared/`는 Worker와 브라우저 양쪽에서 import한다.

## 3. 외부 데이터 소스

### 3.1 카카오 로컬 API (공식)

- `GET https://dapi.kakao.com/v2/local/search/category.json`
- 파라미터: `category_group_code=FD6`, `rect=minLng,minLat,maxLng,maxLat`, `page=1..3`, `size=15`, `sort=accuracy`
- 헤더: `Authorization: KakaoAK {KAKAO_REST_KEY}`
- 한 번의 검색으로 최대 45개(15 × 3페이지)까지만 받을 수 있다. 응답의 `meta.total_count`로 실제 개수를 확인한다.
- **저장 금지 정책 (2026-10-05 확인):** 카카오맵 API FAQ(2022-10-18)는 "로컬 API 등을 호출하여 응답받은 결과 데이터를 별도로 저장하여 사용하는 것은 허용하지 않습니다"라고 한다. 2026-08-24 답변에 따르면 임시 저장도 불허다. 2026-08-26 답변에 따르면 "장소ID만 기록하고 나머지 표시 정보는 실시간 호출하는 방향은 운영 정책상 허용 가능"하다 (https://devtalk.kakao.com/t/faq-api/125610, https://devtalk.kakao.com/t/api-20/151271). 그래서 **로컬 API 응답에서는 장소 ID만 저장한다.** 이름, 좌표, 카테고리는 요청을 처리하는 동안 메모리에서만 쓴다(간식 제외 판단).

### 3.2 카카오맵 장소 상세 (비공식)

- `GET https://place-api.map.kakao.com/places/panel3/{id}`
- 필수 헤더: `pf: PC`, `Origin: https://place.map.kakao.com`, `Referer: https://place.map.kakao.com/`, 브라우저 User-Agent, `Accept: application/json`. 헤더가 없으면 406이 반환된다(2026-10-05 로컬에서 확인).
- **Cloudflare 엣지에서 호출 가능 확인 (2026-10-05, `wrangler dev --remote`, 3건 모두 200).** 응답 크기는 가게당 50~120KB다.
- 사용하는 필드 (2026-10-05 id 27531028 "중앙해장" 응답으로 확인):
  - 평점: `kakaomap_review.score_set.average_score`, `kakaomap_review.score_set.review_count`
  - 강점: `kakaomap_review.score_set.strength_counts[{id,count}]` + `kakaomap_review.strength_description[{id,name}]`
  - 메뉴: `menu.menus.items[{name, price}]`
  - 영업시간: `open_hours.week_from_today.week_periods[].days[]`. 각 day는 `day_of_the_week_desc`("월(10/5)")와 함께 `on_days.start_end_time_desc`("11:30 ~ 22:00", 자정을 넘기면 "16:00 ~ 02:00"), `on_days.break_times_desc`(["14:30 ~ 18:00 브레이크타임"]) 또는 `off_days_desc`("휴무일")를 가진다.
  - 예약/태그: `place_add_info.ai_mate.store_facility_icons[].text`와 `place_add_info.store_facility_icons[].text`(예: "예약가능"), `place_add_info.full_detail_infos[].items[].contents[].label`(예: "혼밥", "단체석", "회식장소", "점심특선")
  - 메뉴 가격은 -1이나 0일 수 있다(가격 미표기).
  - **장소 요약 (표시 정보의 출처):** `summary.name`, `summary.category.{name1,name2,name3}`, `summary.point.{lat,lon}`, `summary.address.road`(없으면 `disp`), `summary.phone_numbers[0].tel`
- 형식이 바뀌거나 막힐 수 있으므로 **모든 필드는 optional로 파싱**하고, 하나가 실패해도 나머지는 살린다.
- **차단 시 대안:** Worker IP에서 호출이 막히면, 로컬 Node 스크립트로 수집해서 `wrangler d1 execute --remote`로 D1에 적재한다. 이 경우 Cron 상세 수집은 끈다.

## 4. 데이터 모델 (D1)

```sql
CREATE TABLE tiles (
  key TEXT PRIMARY KEY,           -- R1 격자 키
  collected_at INTEGER NOT NULL,
  place_count INTEGER NOT NULL,
  saturated INTEGER NOT NULL DEFAULT 0  -- 최대 깊이에서도 45 초과면 1
);

-- 로컬 API 응답에서는 격자별 장소 ID만 기록한다 (§3.1 저장 금지 정책)
CREATE TABLE tile_places (
  tile_key TEXT NOT NULL,
  place_id TEXT NOT NULL,
  PRIMARY KEY (tile_key, place_id)
);
CREATE INDEX idx_tile_places_place ON tile_places(place_id);

-- 장소 상세(§3.2) 응답에서 얻은 정보. 상세를 한 번도 성공하지 못한 장소는 name 등이 NULL이다
CREATE TABLE places (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,            -- 마지막 시도 결과 'ok' | 'failed'
  name TEXT, category_name TEXT, category_group TEXT, lat REAL, lng REAL, address TEXT, phone TEXT,
  rating REAL, review_count INTEGER, price INTEGER,
  menus_json TEXT, hours_json TEXT, strengths_json TEXT, tags_json TEXT, bookable INTEGER,
  fail_reason TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX idx_places_lat_lng ON places(lat, lng);
```

카카오맵 링크는 `https://place.map.kakao.com/{id}`로 만든다.

## 5. 기능 요구사항

### 5.1 수집: 가게 목록 (공식 API)

- **R1 고정 격자.** 위도 간격 `0.00225°`(약 250m), 경도 간격 `0.0028°`(위도 37.5° 기준 약 250m)로 지도를 나눈다. 격자 키는 `"{floor(lat/0.00225)}:{floor(lng/0.0028)}"`이다. `tilesCoveringCircle(center, radius)`는 원과 겹치는 모든 격자 키를 반환한다.
  - 예: 반경 0이면 중심이 속한 격자 1개, 반경이 격자 경계를 넘으면 인접 격자 포함
- **R2 쿼드트리 분할.** 격자(또는 하위 사각형)를 rect 검색했을 때 `meta.total_count > 45`이면 4등분해서 각각 다시 검색한다. 최대 깊이는 4다(약 15m). 최대 깊이에서도 45를 넘으면 받은 45개의 ID를 기록하고 `tiles.saturated = 1`로 표시한다. 기록하는 것은 **장소 ID뿐**이고, 카테고리가 `dessert`인 장소는 기록하지 않는다(판단은 메모리에서만). 한 격자 안에서 id가 중복되면 한 번만 기록한다.
- **R3 격자 TTL.** `tiles.collected_at`이 7일 이내인 격자는 다시 수집하지 않는다.
- **R4 격자 ID 갱신.** 격자를 다시 수집하면 그 격자의 ID 목록을 새 결과로 통째로 바꾼다. `places`의 상세 행은 지우지 않는다(폐업 판단은 범위 밖).
- **R5 카테고리 그룹.** `category_name`을 `>`로 나눈 두 번째 단계로 매핑한다.

  | 그룹 키 | 표시 | 카카오 2단계 |
  |---|---|---|
  | `korean` | 한식 | 한식 |
  | `chinese` | 중식 | 중식 |
  | `japanese` | 일식 | 일식 |
  | `western` | 양식 | 양식, 패밀리레스토랑 |
  | `asian` | 아시안 | 아시아음식 |
  | `snack` | 분식·패스트푸드 | 분식, 패스트푸드, 도시락 |
  | `bar` | 술집 | 술집 |
  | `dessert` | (항상 제외) | 간식 |
  | `etc` | 기타 | 위에 없는 모든 값 (뷔페, 샐러드, 치킨, 퓨전요리 등) |

  `dessert`는 수집 단계에서 기록하지 않고, 상세 카테고리가 `dessert`로 나온 장소도 API 응답에서 제외한다. 감사 리포트(Q4)는 `etc`로 떨어진 2단계 값 목록을 출력하고, 필요하면 이 표를 고친다.

### 5.2 수집: 상세 정보 (비공식 API)

- **R6 상세 파싱.** §3.2의 응답을 섹션별 zod 스키마로 검증해 `PlaceSummary`(이름, 카테고리 원문, 좌표, 주소, 전화)와 `PlaceDetail`로 변환한다. 요약에서 이름이나 좌표가 없으면 표시할 수 없으므로 `schema` 실패로 본다. 나머지 섹션은 optional이다.
  - `rating`: `average_score`. 리뷰가 0개면 null
  - `strengths`: `strength_counts`를 count 내림차순으로 정렬해 상위 2개 id를 `strength_description`의 이름으로 바꾼 것
  - `bookable`: `place_add_info`가 없으면 null이다. 있으면 두 `store_facility_icons` 목록 중 하나라도 text가 "예약가능"이면 true, 아니면 false다.
  - `tags`: `full_detail_infos[].items[].contents[].label`을 순서대로 중복 없이 모은다(최대 30개).
  - `menus`: 가격이 1 이상인 메뉴만, 최대 20개
  - JSON이 아니거나 최상위 구조가 다르면 `status='failed'`, `fail_reason='schema'`
- **R7 대표 가격.** 메뉴 가격 중 `5,000 ≤ price ≤ 30,000`인 값들의 중앙값을 100원 단위로 반올림한다. 해당 값이 없으면 null이다. 값이 짝수 개면 가운데 두 값의 평균을 쓴다.
  - 예: [14000, 16000, 16000, 67000] → [14000, 16000, 16000] → 16000
- **R8 영업시간 정규화.** §3.2의 day 목록을 `Hours = { [요일 0(일)-6(토)]: Array<[openMin, closeMin]> | "closed" }`로 정규화한다. 분 단위이고, 자정을 넘기면 close가 1440보다 크다(예: "16:00 ~ 02:00" → [960, 1560]). 브레이크타임은 구간에서 빼서 나눈다(예: "11:30 ~ 22:00" + "14:30 ~ 18:00" → [[690, 870], [1080, 1320]]). `off_days_desc`가 있으면 "closed"다. 요일은 `day_of_the_week_desc`의 첫 글자(일월화수목금토)로 정한다. 하나라도 파싱할 수 없으면 전체를 null로 한다.
- **R9 상세 TTL과 재시도.** `status='ok'`이면 3일, `status='failed'`이면 6시간이 지나기 전에는 다시 가져오지 않는다. 갱신에 실패해도 이전에 성공한 표시 정보는 지우지 않는다(상태만 failed로 바꾼다). 호출마다 네트워크 오류나 5xx가 나면 지수 백오프(250ms, 1000ms)로 최대 2번 재시도한다. 4xx는 재시도하지 않는다.
- **R10 배치 처리.** 한 번의 실행(요청 또는 Cron)에서 외부 호출 예산은 `SUBREQUEST_BUDGET`(기본 40, 무료 플랜 한도 50)이다. 격자 수집이 예산을 먼저 쓰고, 상세 보충은 남은 예산 안에서 기준점에서 가까운 순으로 동시성 3으로 처리한다. 대상은 기준점을 덮는 격자에 기록된 ID 중 상세가 없거나 만료된 것이고, 격자 중심이 기준점에 가까운 순서(같으면 id 오름차순)로 고른다. 배치 중에 403이나 429가 나오면 차단 신호로 보고 그 배치의 나머지 호출을 멈춘다. 한 번에 보충하는 가게 수는 `DETAIL_BATCH_SIZE`(기본 10)다. 응답이 커서 무료 플랜 CPU 한도(10ms)를 지키기 위해 작게 잡았다.

### 5.3 사전 수집 (Cron)

- **R11 ASEM 유지 수집.** Cron `*/10 * * * *`로 실행한다. ASEM 기준 반경 1500m를 대상으로 (1) 만료된 격자를 수집하고 (2) 남은 예산으로 상세 정보를 보충한다. 할 일이 없으면 D1 조회만 하고 끝난다. 최초 대량 수집은 R31로 한다.

### 5.4 API

- **R12 `GET /api/places?lat&lng&radius`.**
  - 검증: lat ∈ [33, 39], lng ∈ [124, 132], radius ∈ [100, 2000]. 위반하면 400과 `{error}`를 반환한다.
  - 처리: `tilesCoveringCircle`로 격자를 구하고, 만료/미수집 격자를 예산 안에서 동기적으로 수집한다(ID만 기록). 그다음 D1에서 상세가 있는 가게 중 거리 ≤ radius인 것을 조회한다. 상세가 아직 없는 장소는 좌표를 모르므로 응답에 넣지 않고 `pending`으로만 센다. 상세 정보가 없거나 만료된 가게는 `ctx.waitUntil`로 R10 배치를 시작한다.
  - 응답:
    ```ts
    {
      center: { lat, lng }, radius,
      places: Array<{
        id, name, group, category, lat, lng,
        distance,        // m, 정수
        walkMinutes,     // R26
        address, phone, url,
        detail: null | { rating, reviewCount, price, menus /* 상위 5개 */, hours, strengths, bookable, fetchedAt }
      }>,
      pending: number,   // 덮는 격자에 ID는 기록됐지만 상세를 아직 한 번도 가져오지 않은 장소 수 (반경이 아니라 격자 기준)
      incompleteTiles: number, // 예산 부족으로 이번에 못 수집한 격자 수
      stale: boolean     // R14
    }
    ```
  - `Cache-Control: no-store`
- **R13 `GET /api/places/:id`.** 단일 가게 정보를 반환한다(형식은 R12의 원소와 같고, distance와 walkMinutes는 빠진다). id는 숫자만 허용하고 아니면 404다. 표시 정보가 없으면 R15 제한 안에서 동기적으로 한 번 상세를 가져온다(최근 6시간 안에 실패했으면 시도하지 않음). 그래도 없으면 404다.
- **R14 장애 대응.** 공식 API가 실패하고(쿼터 초과, 5xx, 타임아웃) 해당 격자에 만료된 캐시가 있으면 그 캐시로 응답하고 `stale: true`를 준다. 캐시도 없으면 502와 `{error: "upstream"}`을 반환한다.
- **R15 남용 방지.** 외부 호출을 일으키는 요청(만료/미수집 격자가 있는 R12, 동기 보충이 필요한 R13)은 IP당 분당 10회로 제한한다(Workers Rate Limiting 바인딩). 초과하면 외부 호출 없이 캐시로만 응답하고 `stale: true`를 준다. 캐시로만 응답할 수 있는 요청은 제한하지 않는다.

### 5.5 추천 로직 (브라우저, `shared/recommend`)

- **R16 점심시간 → 반경.** 30분은 300m, 60분은 700m, 90분은 1200m다. 점심시간 버튼을 누르면 반경이 이 값으로 바뀐다. 반경 슬라이더(100~2000m, 50m 단위)로 직접 바꿀 수 있고, 이때 점심시간 버튼 선택은 해제된다.
- **R17 영업 중 필터.** 기본 ON. 현재 시각 `now`(KST)와 `now + 30분`이 모두 같은 영업 구간 안에 있을 때만 영업 중으로 본다. 전날 밤부터 이어지는 구간(close > 24:00)도 고려한다. 자정에서 끝나는 구간이 다음 날 0시에 시작하는 구간과 맞닿아 있으면 하나의 연속된 구간으로 본다(다음 날이 휴무면 자정에서 끝난다). 오늘 요일의 정보 자체가 없으면 "영업 정보 없음"으로 취급한다. 영업시간이 null이면 "영업 정보 없음"으로 표시하고 필터를 통과시킨다.
- **R18 필터.**
  - 카테고리: 다중 선택, 아무것도 선택하지 않으면 전체(`bar` 제외). `bar`는 "술집 포함" 토글을 켰을 때만 들어간다(기본 OFF).
  - 1인 예산: 전체 / 1만 이하 / 1.5만 이하 / 2만 이하. "전체"가 아니면 price가 null인 곳은 제외한다.
  - 최소 평점: 무관 / 3.5+ / 4.0+. "무관"이 아니면 rating이 null인 곳은 제외한다.
  - 반경: 거리 ≤ radius
- **R19 인원 휴리스틱.** 인원 선택지는 1 / 2 / 3 / 4+이고 기본값은 2다.
  - 1명: 혼밥 친화(`category_name`에 국밥, 해장국, 라멘, 라면, 분식, 덮밥, 돈까스, 우동, 국수, 김밥, 패스트푸드 중 하나라도 포함하거나, tags에 "혼밥"이 있음)면 가중치 ×1.5
  - 4명 이상: `snack` 그룹 제외. tags에 "단체석", "회식장소", "모임맛집" 중 하나라도 있으면 ×1.3, `bookable === true`면 추가로 ×1.3
  - 2~3명: 보정 없음
- **R20 정렬.** 거리순(기본) / 평점순(null은 맨 뒤) / 가격순(오름차순, null은 맨 뒤).
- **R21 뽑기.** 필터를 통과한 후보에서 가중 랜덤으로 하나를 뽑는다.
  - 가중치 = `base × 인원 보정`
  - `base = max(0.3, rating − 3) × log10(reviewCount + 10)`, rating이 null이면 `base = 0.5`
  - "다시 뽑기"를 누르면 이번 세션에서 이미 뽑힌 곳은 후보에서 제외한다. 후보가 다 떨어지면 제외 목록을 비우고 다시 시작한다.
  - 후보가 0개면 "조건에 맞는 곳이 없어요" 토스트를 띄우고, 리스트 자리의 빈 상태(R29)에 지금 켜져 있는 조건만 푸는 버튼을 보여준다: "영업 중만 해제", "평점 무관", "예산 전체", "카테고리 전체", "반경 +300m"(최대 2000m).
  - 난수 함수는 주입받는다(테스트에서 결정적으로 검증하기 위해).
- **R22 슬롯 셔플 연출.** "모먹죠?"를 누르면 결과 카드(모바일은 바텀 시트) 이름 자리에 후보 이름이 약 0.8초 동안 바뀌다가 결과에서 멈춘다. 이름이 바뀌는 간격은 50ms에서 140ms로 점점 늘어난다(감속). 셔플 중에는 뽑기 버튼을 비활성화하고 "고르는 중…"으로 표시한다. 멈추면 카드가 살짝 튀어 오르며 안착하고, 지원하는 기기는 15ms 진동(`navigator.vibrate`)을 준다. 지도는 그 가게로 이동하고 핀이 커지면서 한 번 퍼진다. 뽑은 뒤 뽑기 버튼 문구는 "다시 뽑기"가 된다. `prefers-reduced-motion`이면 셔플과 애니메이션 없이 바로 결과를 보여준다.
- **R23 공유.** "공유" 버튼을 누르면 아래 텍스트(`shareText`)를 공유한다. 터치 기기(`pointer: coarse`)이고 `navigator.share`가 있으면 클릭 핸들러 안에서 바로 `navigator.share({ title: "모먹죠", text })`를 호출하고, 사용자가 공유 시트를 닫으면(AbortError) 아무것도 하지 않는다. 그 밖의 경우(데스크톱, 미지원, 공유 실패)는 클립보드에 복사하고 "복사했어요" 토스트를 띄운다. 복사도 실패하면 "복사하지 못했어요"를 띄운다.
  ```
  🍚 {인원}명 · {점심시간}분 → {가게명} 어때요?
  {카테고리 3단계} · ⭐{rating} · 도보 {walkMinutes}분
  https://mmj.itmz.me/?p={id}&lat={lat}&lng={lng}&r={radius}
  ```
  평점이 null이면 `⭐` 부분을 생략한다. 인원이 4+이면 "4명+"로 쓰고, 점심시간 버튼 선택이 없으면 `{점심시간}분 → ` 대신 `반경 {radius}m → `를 쓴다. 공유 URL을 열면 해당 기준점과 반경으로 로드한 뒤 가게 `p`를 포커스하고 결과 카드를 연다. 반경 밖이거나 목록에 없으면 R13으로 가져와서 보여준다(도보 시간은 현재 기준점으로 계산). 파라미터를 적용한 뒤에는 주소창에서 지운다(새로고침하면 저장값으로 돌아간다).
  - 링크 미리보기는 `index.html`의 정적 OG 태그로만 한다: `og:title` "모먹죠 - 점심 ㄱ?", `og:description`, `og:image` `https://mmj.itmz.me/og.png`(1200×630 PNG), `twitter:card` `summary_large_image`. 장소별 동적 OG와 카카오 SDK 공유는 하지 않는다.
- **R24 기준점.** 기본값은 ASEM 타워 (37.513059, 127.059826; 카카오 키워드 검색 "ASEM타워" id 17807534, 2026-10-05 확인). 기준점 칩 메뉴에 세 가지가 있다.
  - "내 위치": Geolocation API를 쓴다. 거부되거나 실패하면 ASEM을 유지하고 "위치를 가져오지 못해서 ASEM 타워 기준으로 보여드려요" 토스트를 띄운다.
  - "지도에서 찍기": 다음 지도 클릭 위치를 기준점으로 한다.
  - "ASEM 타워로": 기본값으로 되돌린다.
- **R25 설정 기억.** 필터(점심시간, 인원, 카테고리, 예산, 평점, 영업 중, 술집 포함, 정렬)와 기준점을 localStorage에 저장한다. 읽기/쓰기는 try/catch로 감싸고, 실패하면 기본값을 쓴다. 공유 URL 파라미터가 있으면 저장값보다 우선한다(저장값을 덮어쓰지는 않음).
- **R26 도보 시간.** `walkMinutes = ceil(직선거리 × 1.3 / 70)` (우회 계수 1.3, 분속 70m)

### 5.5.1 관리 기능

- **R31 워밍 엔드포인트.** `POST /api/admin/warm?lat&lng&radius`는 `Authorization: Bearer {ADMIN_TOKEN}`이 맞을 때만 동작하고, 틀리면 401이다. R10 예산 안에서 격자 수집과 상세 보충을 한 번 수행하고 `{incompleteTiles, pending, enriched, failed}`를 반환한다. `scripts/warm.mjs`는 이 엔드포인트를 `incompleteTiles === 0 && pending === 0`이 될 때까지(최대 300회, 호출 간 1초) 반복 호출한다. 요청이 매번 새 실행이라 무료 플랜 한도 안에서 빠르게 채울 수 있다.
- **R32 감사 엔드포인트.** `GET /api/admin/audit?lat&lng&radius`(같은 인증)는 §7의 Q1~Q4 수치를 JSON으로 반환한다. `scripts/audit.mjs`는 이를 표로 출력하고, Q1 또는 Q2를 통과하지 못하면 종료 코드 1로 끝난다.

- **R33 대표 사진.** 상세 응답의 `summary.main_photo_url`이 카카오 CDN(`*.kakaocdn.net`) 주소면 https로 바꿔 `places.photo_url`에 기록한다(사진 파일은 저장하지 않음). 다른 호스트(네이버 블로그 등 외부 사이트에서 막히는 이미지)는 기록하지 않는다. 화면에서는 카카오 썸네일 서버(`img1.kakaocdn.net/cthumb/local/C{px}x{px}.q50/?fname=`)를 거쳐 결과 카드 상단과 목록 썸네일로 보여주고, 사진이 없거나 불러오지 못하면 사진 자리를 숨긴다.

### 5.6 UI

- **R27 레이아웃 (모바일 우선).** 대부분 폰으로 열기 때문에 375×812를 기준으로 설계하고, 900px 이상에서 데스크톱 배치로 바꾼다. 상단 바에는 로고와 기준점 칩이 있다.
  - 모바일: 상단 바 → 지도(화면 높이의 40%) → 패널(필터, 상태 줄, 리스트; 패널만 스크롤). 뽑기 버튼은 화면 하단에 고정된 바에 있고 `env(safe-area-inset-bottom)`만큼 띄운다. `viewport-fit=cover`를 쓰고 노치와 홈 인디케이터 영역을 피한다.
  - 데스크톱(≥ 900px): 왼쪽 패널(400px; 필터, 상태 줄, 리스트, 패널 아래에 붙는 뽑기 버튼) + 오른쪽 지도.
  - 점심시간, 인원, 카테고리("전체" 칩 포함)는 항상 보인다. 1인 예산, 최소 평점, 반경 슬라이더, 영업 중만, 술집 포함은 접이식 "상세 조건"(`<details>`)에 넣고, 접힌 줄에 현재 값을 한 줄로 요약한다(예: "예산 전체 · 평점 무관 · 영업 중만").
  - 터치 대상은 44px 이상, 입력과 선택 상자의 글자는 16px 이상이다(iOS 자동 확대 방지). 마우스 hover에만 기대는 동작은 없다.
- **R28 지도와 상세 카드.** 카카오맵 JS SDK를 쓴다. 기준점 핀, 반경 원(점선 `dash`), 후보 가게 핀(필터를 통과한 곳만, HTML 버튼 CustomOverlay)을 보여준다. 기준점이나 반경이 바뀌면 원이 여백을 두고 화면에 들어오게 맞춘다. 선택된 핀은 커지면서 한 번 퍼지고 가게 이름 라벨을 단다. SDK는 한 번만 불러오고 10초 안에 준비되지 않으면 "지도를 불러오지 못했어요"와 "다시 시도"를 보여준다. "지도에서 찍기" 중에 후보 핀을 누르면 기준점이 아니라 그 가게가 선택된다.
  - 핀이나 리스트 항목을 누르면 뽑기 결과와 같은 형식의 상세 카드를 열고 지도가 그 핀으로 이동한다. 모바일은 뽑기 바 바로 위에 붙는 바텀 시트(최대 화면 높이의 60%, 내부 스크롤, 손잡이 모양, 닫기 버튼)이고, 데스크톱은 지도 위 오버레이다. Esc로 닫는다.
  - 카드 정보 순서: 이름 → 도보 N분 · ⭐평점(리뷰 수) · 영업 상태("영업 중" / "곧 마감" / "지금 닫힘" / "영업 정보 없음"; 닫혔거나 30분 안에 닫으면 포인트 컬러) → 카테고리 · 대표 가격 · 강점 → 메뉴(모바일은 3개 + "메뉴 더보기", 데스크톱은 최대 5개) → 행동("다시 뽑기"는 뽑은 결과일 때만, "공유"가 주 버튼, "카카오맵" 링크) → 작게 "정보 출처: 카카오맵". 모바일에서는 하단 뽑기 바가 "다시 뽑기" 역할을 해서 카드 안의 "다시 뽑기"는 숨긴다. 상세 정보가 없는 가게(R13)는 평점과 메뉴 대신 "평점과 메뉴 정보를 아직 불러오지 못했어요"를 보여준다.
- **R29 로딩과 상태 표시.** 기준점이나 반경이 바뀌면 250ms 디바운스 후 요청하고, 다시 불러오는 동안 이전 리스트를 흐리게 보여준다.
  - 첫 응답 전에는 리스트 자리에 스켈레톤 4줄과 "주변 식당을 찾고 있어요"를 보여준다.
  - `pending > 0` 또는 `incompleteTiles > 0`이면 3초 간격으로 최대 10번 다시 요청하고, 리스트 위 상태 줄에 "주변 가게를 더 찾는 중이에요"(incompleteTiles) 또는 "평점 정보 불러오는 중 (n곳)"(pending)을 표시한다. 10번이 끝났는데도 남아 있으면 "주변 가게를 다 찾지 못했어요" 또는 "n곳은 아직 정보를 못 불러왔어요"로 바꾼다. 다시 요청하는 중에 후보가 0개면 빈 상태 대신 스켈레톤을 유지한다.
  - `stale`이면 "정보가 오래됐을 수 있어요"를 표시한다.
  - 첫 요청이 실패하면 "가게 정보를 불러오지 못했어요"와 "다시 시도" 버튼을 보여준다. 이미 리스트가 있는데 다시 요청이 실패하면 리스트는 두고 상태 줄에 "최신 정보를 불러오지 못했어요"와 "다시 시도"를 보여준다.
  - 후보가 0개면 "점심시간이 코앞인데 후보가 없네요"와 조건 풀기 버튼(R21)을 보여준다.
- **R30 시각 스타일.** 라이트 모드만 지원한다. 웹 페이지가 아니라 앱처럼 보이게 한다(`.superpowers/research/app-feel.md`): 테두리 대신 옅은 면과 구분선, 주 행동은 화면에 하나, 이모지 대신 마스코트와 선 아이콘.
  - 컬러(`web/styles.css` 토큰): 포인트 오렌지 `#FF683D`(핀, 별, 스위치, 진행 막대), 주 버튼 채움 `#E8512A`(흰 글자 3.7:1, 눌림 `#CF4521`), 강조 글자 `#B93D14`(4.5:1 이상), 라이트 오렌지 `#FFE7D3`(틴트 버튼), 크림 `#FFF8F3`(지도 바탕, 사진 자리, 스켈레톤), 소프트 베이지 `#EADCC8`(지도 칩 테두리), 옅은 채움 `#F5EFE9`(칩·세그먼트 트랙·말풍선), 다크 브라운 `#3C2F25`(본문, 선택된 칩; 보조 글자 `#6B5A4C`·`#7A6758`, 모두 AA), 라이트 그레이 `#E9E9E9`(구분선). 상단바는 흰 바탕에 로고(`/brand/logo.png`, 높이 28px)와 기준점 칩(옅은 채움, 위치 아이콘).
  - 조작 요소: 주 버튼 "모먹죠?"(이모지 없음, 높이 54px, 모서리 14px, 17px semibold, 그림자 없음, 누르면 0.97배). 점심시간·인원·예산·평점은 iOS식 세그먼트(트랙 하나 + 미끄러지는 흰 선택 표시). 카테고리 칩은 테두리 없는 옅은 채움, 선택은 다크 브라운 + 흰 글자. 보조 행동(공유, 카카오맵, 다시 시도)은 틴트 버튼. 화면 좌우 여백 20px, 8pt 간격(섹션 24px).
  - 후보 목록: 카드 대신 구분선이 있는 행. 왼쪽 64px 둥근 사진(사진 칸이 있는데 사진이 없으면 크림 + 흐린 `dish` 마스코트), 이름 / "★ 4.3 (320) · 한식"(곧 마감·지금 닫힘이면 앞에 강조 글자로; "영업 중"은 기본값이라 생략), 오른쪽에 "도보 5분" / "1인 9,000원대". 선택된 행은 옅은 오렌지 배경.
  - 결과 시트: 위 모서리 24px, 그래버(아래로 80px 넘게 끌면 닫힘), 옅은 그림자 하나, 조용한 ✕, 행동 버튼은 시트 아래에 붙어 항상 보인다.
  - 지도 핀: 멀리서는 8px 반투명 점(얇은 흰 테두리), 레벨 4 이하로 확대하면 "🍚 4.3" 같은 카테고리·평점 칩(11px, 평점 4.0 이상은 오렌지 테두리 + 라이트 오렌지 바탕), 선택된 핀은 더 큰 오렌지 마커 + 이름표 + 맨 위. 터치 영역은 32px, 확대 전환은 감싸는 요소의 class 하나로 처리한다(오버레이를 다시 만들지 않음).
  - 마스코트: 나침반을 든 스푼("스푼 나침반"). `/brand/pose/*.png` 스티커를 상태별 장식으로만 쓴다(`alt=""`, `aria-hidden`, 크기 명시, 처음부터 보이는 자리가 아니면 lazy). 뽑는 중 `search`(살짝 흔들림, 동작 줄이기 설정이면 정지) + "모먹죠가 고르는 중…" / 뽑기 결과 `thumbsup` + "모먹죠가 찾았어요!" / 후보 없음 `sad` + 말풍선 "앗… 조건에 맞는 맛집이 없어요" + 조건 풀기 칩 / 첫 로딩 `waiting` + "맛있는 맛집을 찾고 있어요!" + 얇은 진행 막대 + 실제 행과 같은 크기의 스켈레톤 / 오류 `warning` + "앗! 일시적인 오류가 발생했어요." + "다시 시도하기" / 공유·복사 성공 토스트(하단 버튼 바로 위) `love` / 기준점 메뉴 머리 `location`.
  - 첫 방문 안내: 필터 위에 `conditions` 마스코트 말풍선("조건을 고르고 모먹죠?를 눌러보세요!"). 첫 뽑기나 ✕로 닫으면 다시 보이지 않는다(localStorage, 저장 실패해도 동작은 막지 않음).
  - 360–430px 폭에서 가로 스크롤이 없어야 한다(긴 이름은 말줄임, 그리드 칸은 `minmax(0, 1fr)`). 페이지 고무줄 스크롤은 막고 패널·시트만 `overscroll-behavior: contain`으로 스크롤한다. 버튼은 `touch-action: manipulation`, 조작 요소 글자는 선택되지 않는다.
  - 앱 아이콘(favicon, apple-touch-icon, 192/512)과 `manifest.webmanifest`(테마 `#FF683D`, 배경 `#FFF8F3`), 공유 미리보기 `og.png`(1200×630)도 v2 브랜드 시트에서 가져온다. 폰트는 Pretendard(CDN). 온보딩·시작 화면, 단계별 필터 화면, 북마크, 푸시 알림, 룰렛 휠, 컨페티, 효과음, 다크 모드는 쓰지 않는다.

## 6. 에러 처리 요약

| 상황 | 동작 | 요구사항 |
|---|---|---|
| 비공식 API 실패 | 재시도 2회 → `failed` 기록 → 6시간 후 재시도. UI는 "평점 정보 없음" | R9 |
| 비공식 API 구조 변경 | zod 실패 → `failed/schema`, 계약 테스트로 조기 발견 | R6 |
| 비공식 API 차단 | 로컬 수집 스크립트 + D1 원격 적재로 전환 | §3.2 |
| 공식 API 실패 | 만료된 캐시로 응답, `stale: true` / 캐시도 없으면 502 | R14 |
| 요청 과다 | 캐시로만 응답 | R15 |
| 위치 권한 거부 | ASEM 유지 + 토스트 | R24 |
| 후보 0개 | 안내 + 켜진 조건 풀기 버튼(반경 +300m 포함) | R21, R29 |
| localStorage 불가 | 기본값으로 동작 | R25 |

## 7. 데이터 품질 수용 기준

`npm run audit`(D1 원격 또는 로컬 대상)은 ASEM 반경 1500m 데이터에 대한 리포트를 출력한다.

- **Q1 누락 없음.** `saturated = 1`인 격자가 0개.
- **Q2 상세 커버리지.** 덮는 격자에 기록된 장소 ID 중 표시 정보를 가진 장소가 95% 이상. 실패한 장소는 목록과 `fail_reason`을 출력한다. Q3, Q4도 같은 ID 집합을 기준으로 한다.
- **Q3 필드 결측률.** ok인 가게 중 rating, price, hours가 각각 null인 비율을 출력한다. 기준치는 없고, 하나라도 50%를 넘으면 파서 버그를 의심해서 픽스처와 대조한다.
- **Q4 분포와 이상치.** 그룹별 가게 수, `etc`로 떨어진 카테고리 2단계 값 목록, 좌표가 유효 범위(lat 33~39, lng 124~132) 밖인 가게 수, 이름과 좌표(소수 5자리)가 같은 중복 의심 묶음 수를 출력한다.
- **Q5 표본 검증.** 직접 고른 근처 가게 10곳을 카카오맵 화면과 대조해 평점(소수 첫째 자리), 메뉴 가격, 영업시간이 일치하는지 확인한다(수동, 결과를 `docs/audit/`에 기록).

Q1, Q2, Q5를 통과해야 UI 마일스톤으로 넘어간다.

## 8. 테스트 전략

| 층위 | 도구 | 대상 | 요구사항 |
|---|---|---|---|
| 단위 (순수) | Vitest | geo, category, price, hours, recommend, share | R1, R5, R7, R8, R16~R21, R23, R26 |
| 계약 | Vitest + 녹화 픽스처 + zod | kakaoLocal 파서, detailParser | R2(응답 형식), R6 |
| 통합 | `@cloudflare/vitest-pool-workers` (D1 miniflare), fetch 모킹 | TileCollector, DetailEnricher, API 라우트, scheduled | R2~R4, R9~R15 |
| 데이터 | `npm run audit` | 실제 수집 데이터 | Q1~Q5 |
| 수동 | 브라우저 | UI | R22, R24, R27~R30 |

- 픽스처는 `test/fixtures/`에 실제 응답을 녹화해서 저장한다. 최소 범위: 공식 API 1페이지 응답, `total_count > 45` 응답, 상세 응답 5곳 이상(메뉴 없음, 평점 없음, 브레이크타임 있음, 자정 넘김, 휴무일 있음 케이스 포함).
- 시계와 난수는 주입해서 테스트한다. 영업시간 테스트는 KST 고정 시각으로 작성한다.

## 9. 배포와 설정

- Worker 이름 `momeokjo`, 정적 에셋은 `@cloudflare/vite-plugin`으로 빌드한다.
- 바인딩: D1 `DB`, Rate Limiting `RATE_LIMITER`, 시크릿 `KAKAO_REST_KEY`·`ADMIN_TOKEN`, 변수 `SUBREQUEST_BUDGET`, `DETAIL_BATCH_SIZE`
- `compatibility_date`는 `2026-08-01`(로컬 workerd가 지원하는 최신 날짜 이하)
- 프론트엔드 환경 변수: `VITE_KAKAO_JS_KEY` (공개 키)
- Custom Domain: `mmj.itmz.me`
- **카카오 개발자 콘솔 (2026-10-05 완료):** 앱 "모먹죠"(ID 1597800) 생성, JavaScript SDK 도메인에 `http://localhost:5173`·`https://mmj.itmz.me` 등록, 카카오맵 활성화(계정의 무료 쿼터가 이 앱에 귀속됨). 키는 `.dev.vars`(REST)와 `.env.local`(JS)에 있고 git에서 제외된다.

## 10. 마일스톤 (하루)

1. **리스크 제거:** ~~픽스처 녹화~~, ~~엣지에서 비공식 API 호출 확인~~, ~~ASEM 좌표와 R6 예약 필드 확정~~ (2026-10-05 완료) → 프로젝트 스캐폴딩
2. **데이터 파이프라인 (TDD):** geo, category, price, hours, 파서 → TileCollector, DetailEnricher → Cron, R31, R32 → 배포 후 `warm`으로 원격 D1에 ASEM 데이터 수집 → **Q1~Q5 통과**
3. **API + 추천 로직 (TDD):** R12~R15, R16~R21, R23, R26
4. **UI:** 레이아웃, 지도, 필터, 리스트, 뽑기, 공유, 기준점
5. **배포:** `mmj.itmz.me` 연결, 실제 데이터로 점검

## 11. 2단계 (참고, 이번 범위 밖)

익명 사내 추천: `recommendations(place_id, kind, comment, ip_hash, created_at)` 테이블을 추가하고, 👍와 한 줄 코멘트, "4인 이상 OK" 같은 태그를 받는다. 쓰기 요청은 R15와 같은 방식으로 제한한다.
