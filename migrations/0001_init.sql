CREATE TABLE tiles (
  key TEXT PRIMARY KEY,
  collected_at INTEGER NOT NULL,
  place_count INTEGER NOT NULL,
  saturated INTEGER NOT NULL DEFAULT 0
);

-- 카카오 로컬 API 응답은 저장하지 않는다. 격자별 장소 ID만 기록한다 (카카오 운영 정책상 허용).
CREATE TABLE tile_places (
  tile_key TEXT NOT NULL,
  place_id TEXT NOT NULL,
  PRIMARY KEY (tile_key, place_id)
);
CREATE INDEX idx_tile_places_place ON tile_places(place_id);

-- 장소 상세 응답에서 얻은 정보. 상세를 한 번도 성공하지 못한 장소는 name 등이 NULL이다.
CREATE TABLE places (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  name TEXT,
  category_name TEXT,
  category_group TEXT,
  lat REAL,
  lng REAL,
  address TEXT,
  phone TEXT,
  rating REAL,
  review_count INTEGER,
  price INTEGER,
  menus_json TEXT,
  hours_json TEXT,
  strengths_json TEXT,
  tags_json TEXT,
  bookable INTEGER,
  fail_reason TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX idx_places_lat_lng ON places(lat, lng);
