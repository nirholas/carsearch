-- carsearch storage schema, PostgreSQL.
--
-- Kept as its own file rather than generated from the SQLite one. The two
-- differ in a handful of places that matter (identity columns, JSONB, partial
-- index syntax, upsert phrasing), and a translation layer that papers over
-- those differences hides exactly the bugs that only appear in production.
--
-- Every table here mirrors schema.sql. When one changes, both change.

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
  mileage_is_rounded  BOOLEAN NOT NULL DEFAULT FALSE,

  location            TEXT,
  seller_type         TEXT,
  body_type           TEXT,
  exterior_color      TEXT,
  fuel_type           TEXT,

  event_date          TEXT,
  image_url           TEXT,

  first_seen          TIMESTAMPTZ NOT NULL,
  last_seen           TIMESTAMPTZ NOT NULL,
  delisted_at         TIMESTAMPTZ,

  raw                 JSONB
);

CREATE INDEX IF NOT EXISTS idx_listings_lookup   ON listings (LOWER(make), LOWER(model), year);
CREATE INDEX IF NOT EXISTS idx_listings_price    ON listings (price);
CREATE INDEX IF NOT EXISTS idx_listings_vin      ON listings (vin) WHERE vin IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_listings_source   ON listings (source_id);
CREATE INDEX IF NOT EXISTS idx_listings_lastseen ON listings (last_seen);
CREATE INDEX IF NOT EXISTS idx_listings_kind     ON listings (price_kind);
-- Sold comparables are read on every rated listing, so they get their own index.
CREATE INDEX IF NOT EXISTS idx_listings_sold     ON listings (LOWER(make), LOWER(model), year)
  WHERE price_kind = 'sold' AND price IS NOT NULL;

-- Price history cannot be backfilled. It exists only because every run compares
-- against what was there before, which is why this table is the reason the
-- database had to stop living on an ephemeral disk.
CREATE TABLE IF NOT EXISTS price_points (
  listing_id  TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  price       INTEGER NOT NULL,
  PRIMARY KEY (listing_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_price_points_listing ON price_points (listing_id, observed_at);

CREATE TABLE IF NOT EXISTS rejects (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id   TEXT NOT NULL,
  title       TEXT,
  why         TEXT NOT NULL,
  payload     JSONB,
  observed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejects_why ON rejects (why, observed_at);

CREATE TABLE IF NOT EXISTS vehicle_groups (
  group_id   TEXT NOT NULL,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  confidence TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (group_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_groups_listing ON vehicle_groups (listing_id);

CREATE TABLE IF NOT EXISTS vin_decodes (
  vin        TEXT PRIMARY KEY,
  decoded    JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS recalls (
  make         TEXT NOT NULL,
  model        TEXT NOT NULL,
  year         INTEGER NOT NULL,
  campaigns    JSONB NOT NULL,
  park_it      BOOLEAN NOT NULL DEFAULT FALSE,
  park_outside BOOLEAN NOT NULL DEFAULT FALSE,
  fetched_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (make, model, year)
);

CREATE TABLE IF NOT EXISTS source_runs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id    TEXT NOT NULL,
  ran_at       TIMESTAMPTZ NOT NULL,
  ok           BOOLEAN NOT NULL,
  listings     INTEGER NOT NULL DEFAULT 0,
  rejected     INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_runs ON source_runs (source_id, ran_at);
