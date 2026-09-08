import type { Listing } from '../core/types.js';

/**
 * The listing table's columns, defined once.
 *
 * Both stores previously carried a hand-written positional INSERT with a
 * matching hand-written value array. That pairing is invisible to the type
 * checker: adding a column in one place and forgetting the other produces a
 * silent off-by-one where every field after the gap is written into the wrong
 * column. Generating the SQL from this table makes that class of bug
 * impossible, and it is why the facet expansion could add twenty-four columns
 * without touching either INSERT statement.
 */

export type Refresh =
  /** Overwrite on every re-observation. The source is authoritative each run. */
  | 'always'
  /**
   * Keep the existing value when the new one is null. Used for anything learned
   * by enrichment or published inconsistently: a VIN, a title status or an
   * owner count that appeared once must not be erased by a later crawl of a
   * page that happened not to render it.
   */
  | 'coalesce'
  /** Written at insert and never updated. */
  | 'never';

export type SqlType = 'TEXT' | 'INTEGER' | 'REAL' | 'BOOLEAN' | 'JSON';

export interface ColumnDef {
  column: string;
  type: SqlType;
  get: (l: Listing) => unknown;
  set: (l: Record<string, unknown>, v: unknown) => void;
  refresh: Refresh;
}

const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** JSON round-trip for the two array/object columns, tolerant of either backend's shape. */
const json = (v: unknown): unknown => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v;
};

function def<K extends keyof Listing>(
  key: K,
  column: string,
  type: SqlType,
  refresh: Refresh,
  coerce: (v: unknown) => unknown = (v) => v ?? null,
): ColumnDef {
  return {
    column,
    type,
    refresh,
    get: (l) => l[key] ?? null,
    set: (target, v) => { target[key as string] = coerce(v); },
  };
}

export const COLUMNS: readonly ColumnDef[] = [
  def('id', 'id', 'TEXT', 'never', strOrNull),
  def('sourceId', 'source_id', 'TEXT', 'never', strOrNull),
  def('sourceListingId', 'source_listing_id', 'TEXT', 'never', strOrNull),
  def('url', 'url', 'TEXT', 'always', strOrNull),
  def('title', 'title', 'TEXT', 'always', strOrNull),
  def('year', 'year', 'INTEGER', 'coalesce', numOrNull),
  def('make', 'make', 'TEXT', 'coalesce', strOrNull),
  def('model', 'model', 'TEXT', 'coalesce', strOrNull),
  def('trim', 'trim', 'TEXT', 'coalesce', strOrNull),
  def('series', 'series', 'TEXT', 'coalesce', strOrNull),
  def('vin', 'vin', 'TEXT', 'coalesce', strOrNull),
  def('price', 'price', 'INTEGER', 'always', numOrNull),
  def('priceKind', 'price_kind', 'TEXT', 'never', strOrNull),
  def('currency', 'currency', 'TEXT', 'never', strOrNull),
  def('mileage', 'mileage', 'INTEGER', 'always', numOrNull),
  { column: 'mileage_is_rounded', type: 'BOOLEAN', refresh: 'always', get: (l) => l.mileageIsRounded, set: (t, v) => { t.mileageIsRounded = Boolean(v); } },
  def('location', 'location', 'TEXT', 'always', strOrNull),
  def('sellerType', 'seller_type', 'TEXT', 'coalesce', strOrNull),
  def('bodyType', 'body_type', 'TEXT', 'coalesce', strOrNull),
  def('exteriorColor', 'exterior_color', 'TEXT', 'coalesce', strOrNull),
  def('fuelType', 'fuel_type', 'TEXT', 'coalesce', strOrNull),
  def('eventDate', 'event_date', 'TEXT', 'coalesce', strOrNull),
  def('imageUrl', 'image_url', 'TEXT', 'always', strOrNull),

  // Facets. Every one is `coalesce`: these are published inconsistently and
  // filled by enrichment, so a run that did not see one must not delete it.
  def('titleStatus', 'title_status', 'TEXT', 'coalesce', strOrNull),
  def('owners', 'owners', 'INTEGER', 'coalesce', numOrNull),
  def('accidents', 'accidents', 'INTEGER', 'coalesce', numOrNull),
  def('accidentFree', 'accident_free', 'BOOLEAN', 'coalesce', bool),
  def('serviceRecords', 'service_records', 'BOOLEAN', 'coalesce', bool),
  def('usage', 'usage_history', 'TEXT', 'coalesce', strOrNull),
  def('isImport', 'is_import', 'BOOLEAN', 'coalesce', bool),
  def('openRecall', 'open_recall', 'BOOLEAN', 'coalesce', bool),
  def('transmission', 'transmission', 'TEXT', 'coalesce', strOrNull),
  def('drivetrain', 'drivetrain', 'TEXT', 'coalesce', strOrNull),
  def('engine', 'engine', 'TEXT', 'coalesce', strOrNull),
  def('cylinders', 'cylinders', 'INTEGER', 'coalesce', numOrNull),
  def('displacementL', 'displacement_l', 'REAL', 'coalesce', numOrNull),
  def('doors', 'doors', 'INTEGER', 'coalesce', numOrNull),
  def('seats', 'seats', 'INTEGER', 'coalesce', numOrNull),
  def('mpgCity', 'mpg_city', 'INTEGER', 'coalesce', numOrNull),
  def('mpgHighway', 'mpg_highway', 'INTEGER', 'coalesce', numOrNull),
  def('rangeMiles', 'range_miles', 'INTEGER', 'coalesce', numOrNull),
  def('batteryKwh', 'battery_kwh', 'REAL', 'coalesce', numOrNull),
  def('interiorColor', 'interior_color', 'TEXT', 'coalesce', strOrNull),
  def('certified', 'certified', 'BOOLEAN', 'coalesce', bool),
  def('dealerName', 'dealer_name', 'TEXT', 'coalesce', strOrNull),
  def('dealerRating', 'dealer_rating', 'REAL', 'coalesce', numOrNull),
  {
    column: 'options',
    type: 'JSON',
    refresh: 'coalesce',
    get: (l) => (l.options?.length ? JSON.stringify(l.options) : null),
    set: (t, v) => { t.options = json(v) as string[] | null; },
  },
  {
    column: 'raw',
    type: 'JSON',
    refresh: 'always',
    get: (l) => (l.raw ? JSON.stringify(l.raw) : null),
    set: (t, v) => { t.raw = (json(v) as Record<string, unknown>) ?? undefined; },
  },
];

/** Columns written by an INSERT, in order. Timestamps are supplied by the caller's SQL. */
export const INSERT_COLUMNS = COLUMNS.map((c) => c.column);

export function insertValues(l: Listing): unknown[] {
  return COLUMNS.map((c) => c.get(l));
}

/** The `SET` clause of the upsert, honouring each column's refresh policy. */
export function updateAssignments(table: string): string {
  return COLUMNS.filter((c) => c.refresh !== 'never')
    .map((c) =>
      c.refresh === 'coalesce'
        ? `${c.column} = COALESCE(EXCLUDED.${c.column}, ${table}.${c.column})`
        : `${c.column} = EXCLUDED.${c.column}`,
    )
    .join(', ');
}

/**
 * Turns a database row into a Listing.
 *
 * Shared by both backends so that a column added here appears in search results
 * from SQLite and Postgres at the same moment, rather than in whichever one the
 * developer remembered.
 */
export function rowToListing(r: Record<string, unknown>): Listing {
  const target: Record<string, unknown> = {};
  for (const c of COLUMNS) c.set(target, r[c.column]);
  const iso = (v: unknown): string =>
    v instanceof Date ? v.toISOString() : typeof v === 'number' ? new Date(v).toISOString() : String(v ?? '');
  target.firstSeen = iso(r.first_seen);
  target.lastSeen = iso(r.last_seen);
  return target as unknown as Listing;
}

/**
 * Brings an existing listings table up to the current column set.
 *
 * Generated from COLUMNS rather than written out, so adding a facet to that
 * table migrates both backends on next boot with nothing else to remember. Both
 * databases already exist in the wild, so the schema files alone cannot do this:
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that is merely out of
 * date, which is exactly the case that needs handling.
 */
const PG_TYPES: Record<SqlType, string> = {
  TEXT: 'TEXT', INTEGER: 'INTEGER', REAL: 'DOUBLE PRECISION', BOOLEAN: 'BOOLEAN', JSON: 'JSONB',
};
const SQLITE_TYPES: Record<SqlType, string> = {
  TEXT: 'TEXT', INTEGER: 'INTEGER', REAL: 'REAL', BOOLEAN: 'INTEGER', JSON: 'TEXT',
};

/** Columns the base schema has always had, so migration only considers the rest. */
const BASE = new Set([
  'id', 'source_id', 'source_listing_id', 'url', 'title', 'year', 'make', 'model', 'trim', 'series',
  'vin', 'price', 'price_kind', 'currency', 'mileage', 'mileage_is_rounded', 'location', 'seller_type',
  'body_type', 'exterior_color', 'fuel_type', 'event_date', 'image_url', 'first_seen', 'last_seen',
  'delisted_at', 'raw',
]);

export function postgresMigrations(): string[] {
  return COLUMNS.filter((c) => !BASE.has(c.column)).map(
    (c) => `ALTER TABLE listings ADD COLUMN IF NOT EXISTS ${c.column} ${PG_TYPES[c.type]}`,
  );
}

/** SQLite has no ADD COLUMN IF NOT EXISTS, so the caller supplies what already exists. */
export function sqliteMigrations(existing: Set<string>): string[] {
  return COLUMNS.filter((c) => !BASE.has(c.column) && !existing.has(c.column)).map(
    (c) => `ALTER TABLE listings ADD COLUMN ${c.column} ${SQLITE_TYPES[c.type]}`,
  );
}
