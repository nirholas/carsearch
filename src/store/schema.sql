-- carsearch storage schema.
--
-- SQLite so a full aggregator runs locally with no service to stand up. Every
-- statement here is plain enough to port to Postgres unchanged apart from the
-- autoincrement and the JSON type name.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS listings (
  id                  TEXT PRIMARY KEY,
  source_id           TEXT NOT NULL,
  source_listing_id   TEXT,
  url                 TEXT,

  title               TEXT NOT NULL,
  year                INTEGER,
  make                TEXT,
  model               TEXT,
  trim                TEXT,
  series              TEXT,

  vin                 TEXT,
  price               INTEGER,
  price_kind          TEXT NOT NULL DEFAULT 'ask',
  currency            TEXT NOT NULL DEFAULT 'USD',
  mileage             INTEGER,
  mileage_is_rounded  INTEGER NOT NULL DEFAULT 0,

  location            TEXT,
  seller_type         TEXT,
  body_type           TEXT,
  exterior_color      TEXT,
  fuel_type           TEXT,

  event_date          TEXT,
  image_url           TEXT,

  first_seen          TEXT NOT NULL,
  last_seen           TEXT NOT NULL,
  -- Set when a listing stops appearing in results. A car that disappears near
  -- its asking price probably sold at it, which is a signal worth keeping.
  delisted_at         TEXT,

  raw                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_lookup   ON listings(make, model, year);
CREATE INDEX IF NOT EXISTS idx_listings_price    ON listings(price);
CREATE INDEX IF NOT EXISTS idx_listings_vin      ON listings(vin) WHERE vin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_source   ON listings(source_id);
CREATE INDEX IF NOT EXISTS idx_listings_lastseen ON listings(last_seen);
CREATE INDEX IF NOT EXISTS idx_listings_kind     ON listings(price_kind);

-- Price history cannot be backfilled. Every run that sees a listing at a new
-- price writes a row here, and days-on-market plus price-drop detection are
-- derived from this table. It is the highest-value data the project owns and
-- the only part a competitor cannot simply re-scrape.
CREATE TABLE IF NOT EXISTS price_points (
  listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  price       INTEGER NOT NULL,
  PRIMARY KEY (listing_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_price_points_listing ON price_points(listing_id, observed_at);

-- Records that failed validation, kept with the reason. Silent filtering hides
-- parser rot; a rejects table with a reason is how a broken extractor is caught
-- before it ships wrong numbers.
CREATE TABLE IF NOT EXISTS rejects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id   TEXT NOT NULL,
  title       TEXT,
  why         TEXT NOT NULL,
  payload     TEXT,
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejects_why ON rejects(why, observed_at);

-- Groups of listings determined to be the same physical car.
CREATE TABLE IF NOT EXISTS vehicle_groups (
  group_id   TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  confidence TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_groups_listing ON vehicle_groups(listing_id);

-- VIN decode cache. vPIC is free and has no observed rate limit, but a decode
-- is a network round trip and a VIN never changes its meaning.
CREATE TABLE IF NOT EXISTS vin_decodes (
  vin        TEXT PRIMARY KEY,
  decoded    TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- Recall campaigns by make, model and year. Includes the park-it flags, which
-- are the only safety signal in this project that can matter the same day.
CREATE TABLE IF NOT EXISTS recalls (
  make        TEXT NOT NULL,
  model       TEXT NOT NULL,
  year        INTEGER NOT NULL,
  campaigns   TEXT NOT NULL,
  park_it     INTEGER NOT NULL DEFAULT 0,
  park_outside INTEGER NOT NULL DEFAULT 0,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (make, model, year)
);

-- Per-source health over time. A green-to-red transition here is how a bot
-- defense change is noticed, instead of noticing a silently empty result set.
CREATE TABLE IF NOT EXISTS source_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL,
  ran_at       TEXT NOT NULL,
  ok           INTEGER NOT NULL,
  listings     INTEGER NOT NULL DEFAULT 0,
  rejected     INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_runs ON source_runs(source_id, ran_at);
