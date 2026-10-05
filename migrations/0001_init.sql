CREATE TABLE places (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category_name TEXT NOT NULL,
  category_group TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  address TEXT,
  phone TEXT,
  place_url TEXT NOT NULL,
  collected_at INTEGER NOT NULL
);
CREATE INDEX idx_places_lat_lng ON places(lat, lng);

CREATE TABLE place_details (
  id TEXT PRIMARY KEY REFERENCES places(id),
  status TEXT NOT NULL,
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

CREATE TABLE tiles (
  key TEXT PRIMARY KEY,
  collected_at INTEGER NOT NULL,
  place_count INTEGER NOT NULL,
  saturated INTEGER NOT NULL DEFAULT 0
);
