PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS venues (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  address     TEXT,
  city        TEXT,
  region      TEXT,
  country     TEXT,
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  time_zone   TEXT NOT NULL,
  website     TEXT,
  phone       TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  source_id   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The deal search filters on a lat/lon bounding box before it measures exact
-- distances, so latitude leads the index: it is the more selective of the two
-- for the metro-scale radii the app offers.
CREATE INDEX IF NOT EXISTS idx_venues_lat_lon ON venues (lat, lon);
CREATE UNIQUE INDEX IF NOT EXISTS idx_venues_source ON venues (source, source_id)
  WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS deals (
  id               TEXT PRIMARY KEY,
  venue_id         TEXT NOT NULL REFERENCES venues (id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  price_text       TEXT,
  category         TEXT NOT NULL DEFAULT 'both'
                     CHECK (category IN ('drink', 'food', 'both')),
  fine_print       TEXT,
  confidence       REAL NOT NULL DEFAULT 0.5
                     CHECK (confidence >= 0 AND confidence <= 1),
  source_url       TEXT,
  extracted_by     TEXT NOT NULL DEFAULT 'manual'
                     CHECK (extracted_by IN ('heuristic', 'model', 'seed', 'manual')),
  -- Deals from venues you have an agreement with. These are entered by hand,
  -- outrank scraped results, and are never overwritten by a crawl.
  partner          INTEGER NOT NULL DEFAULT 0 CHECK (partner IN (0, 1)),
  last_verified_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deals_venue ON deals (venue_id);

CREATE TABLE IF NOT EXISTS deal_windows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id     TEXT NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  -- end_min may exceed 1440 for a window that runs past midnight.
  start_min   INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min     INTEGER NOT NULL CHECK (end_min > start_min AND end_min <= 2880)
);

CREATE INDEX IF NOT EXISTS idx_deal_windows_deal ON deal_windows (deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_windows_day ON deal_windows (day_of_week);

-- Crawler bookkeeping. Keeping fetch results here is what lets a re-run skip
-- pages that have not changed, which matters because the polite crawl delay
-- makes refetching expensive in wall-clock time.
CREATE TABLE IF NOT EXISTS scraped_pages (
  url          TEXT PRIMARY KEY,
  host         TEXT NOT NULL,
  venue_id     TEXT REFERENCES venues (id) ON DELETE SET NULL,
  status       INTEGER,
  content_hash TEXT,
  text_content TEXT,
  error        TEXT,
  fetched_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_scraped_pages_host ON scraped_pages (host);
CREATE INDEX IF NOT EXISTS idx_scraped_pages_venue ON scraped_pages (venue_id);
