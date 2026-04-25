-- Basket run header: one row per fill:basket invocation
CREATE TABLE IF NOT EXISTS basket_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer    TEXT    NOT NULL,
  zip         TEXT    NOT NULL,
  fill_rate   REAL    NOT NULL DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- One row per requested item in a run
CREATE TABLE IF NOT EXISTS basket_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  basket_run_id   INTEGER NOT NULL REFERENCES basket_runs(id) ON DELETE CASCADE,
  requested_query TEXT    NOT NULL,
  brand_preference TEXT,
  size_preference  TEXT,
  notes            TEXT
);

-- One row per matched product (or NULL if unmatched)
CREATE TABLE IF NOT EXISTS basket_matches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  basket_request_id    INTEGER NOT NULL REFERENCES basket_requests(id) ON DELETE CASCADE,
  matched_product_name TEXT,
  product_url          TEXT,
  image_url            TEXT,
  price                REAL,
  size                 TEXT,
  confidence           REAL    NOT NULL DEFAULT 0,
  match_notes          TEXT,
  is_substitute        INTEGER NOT NULL DEFAULT 0,
  is_unmatched         INTEGER NOT NULL DEFAULT 0,
  cached               INTEGER NOT NULL DEFAULT 0
);

-- Product search cache: avoids re-hitting retailer API for same query
CREATE TABLE IF NOT EXISTS product_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer     TEXT    NOT NULL,
  location_id  TEXT    NOT NULL,
  query_key    TEXT    NOT NULL,
  results_json TEXT    NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(retailer, location_id, query_key)
);

-- Location cache: maps ZIP -> retailer location ID
CREATE TABLE IF NOT EXISTS location_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer    TEXT NOT NULL,
  zip         TEXT NOT NULL,
  location_id TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(retailer, zip)
);

CREATE INDEX IF NOT EXISTS idx_basket_requests_run ON basket_requests(basket_run_id);
CREATE INDEX IF NOT EXISTS idx_basket_matches_req  ON basket_matches(basket_request_id);
CREATE INDEX IF NOT EXISTS idx_product_cache_key   ON product_cache(retailer, location_id, query_key);
