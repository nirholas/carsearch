import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import type { Listing, RejectedListing, PriceKind } from '../core/types.js';
import { FACETS } from '../core/facets.js';
import { buildFacetPredicates } from './filter.js';
import { INSERT_COLUMNS, insertValues, updateAssignments, rowToListing, sqliteMigrations } from './columns.js';
import type { DedupeGroup } from '../core/dedupe.js';
import type { SearchFilters, FacetCoverage } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));

export type { SearchFilters, FacetCoverage } from './store.js';

export class Store {
  private db: Database.Database;

  constructor(path = 'data/carsearch.db') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
    const existing = new Set(
      (this.db.prepare('PRAGMA table_info(listings)').all() as { name: string }[]).map((r) => r.name),
    );
    for (const sql of sqliteMigrations(existing)) this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Inserts or updates a listing and records a price point when the price moved.
   *
   * The price-point write is the reason this is an upsert rather than a replace:
   * days-on-market and price-drop history only exist if every run compares
   * against what was there before.
   */
  upsertListing(l: Listing): { inserted: boolean; priceChanged: boolean } {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare('SELECT id, price, first_seen FROM listings WHERE id = ?')
      .get(l.id) as { id: string; price: number | null; first_seen: string } | undefined;

    const firstSeen = existing?.first_seen ?? l.firstSeen ?? now;
    const cols = INSERT_COLUMNS;

    this.db
      .prepare(
        `INSERT INTO listings (${cols.join(', ')}, first_seen, last_seen)
         VALUES (${cols.map(() => '?').join(', ')}, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ${updateAssignments('listings')},
           last_seen = excluded.last_seen, delisted_at = NULL`,
      )
      .run(
        ...insertValues(l).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number | null))),
        firstSeen,
        now,
      );

    const priceChanged = l.price !== null && existing !== undefined && existing.price !== l.price;
    if (l.price !== null && (!existing || priceChanged)) {
      this.db
        .prepare('INSERT OR IGNORE INTO price_points (listing_id, observed_at, price) VALUES (?, ?, ?)')
        .run(l.id, now, l.price);
    }

    /**
     * Dated prices the source published for days before we ever saw the car.
     * Seeded only on first insert, so a purge of bad points is not silently
     * undone by the next crawl.
     */
    if (!existing && l.priceHistory?.length) {
      const seed = this.db.prepare(
        'INSERT OR IGNORE INTO price_points (listing_id, observed_at, price) VALUES (?, ?, ?)',
      );
      for (const point of l.priceHistory) seed.run(l.id, point.observedAt, point.price);
    }

    return { inserted: !existing, priceChanged };
  }

  upsertMany(listings: Listing[]): { inserted: number; updated: number; priceChanges: number } {
    let inserted = 0;
    let priceChanges = 0;
    const tx = this.db.transaction((rows: Listing[]) => {
      for (const l of rows) {
        const r = this.upsertListing(l);
        if (r.inserted) inserted++;
        if (r.priceChanged) priceChanges++;
      }
    });
    tx(listings);
    return { inserted, updated: listings.length - inserted, priceChanges };
  }

  recordRejects(rejects: RejectedListing[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO rejects (source_id, title, why, payload, observed_at) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this.db.transaction((rows: RejectedListing[]) => {
      for (const r of rows) stmt.run(r.sourceId, r.title ?? null, r.why, JSON.stringify(r), now);
    });
    tx(rejects);
  }

  saveGroups(groups: DedupeGroup[]): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO vehicle_groups (group_id, listing_id, confidence, is_primary) VALUES (?, ?, ?, ?)',
    );
    const tx = this.db.transaction((gs: DedupeGroup[]) => {
      for (const g of gs) {
        const groupId = g.primary.id;
        for (const m of g.members) {
          stmt.run(groupId, m.id, g.confidence, m.id === g.primary.id ? 1 : 0);
        }
      }
    });
    tx(groups);
  }

  recordRun(sourceId: string, ok: boolean, listings: number, rejected: number, durationMs: number, error?: string): void {
    this.db
      .prepare(
        'INSERT INTO source_runs (source_id, ran_at, ok, listings, rejected, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(sourceId, new Date().toISOString(), ok ? 1 : 0, listings, rejected, durationMs, error ?? null);
  }

  /** Marks listings from a source that were not seen in this run. A car that vanishes near its asking price probably sold at it. */
  markDelisted(sourceId: string, seenIds: string[]): number {
    if (seenIds.length === 0) return 0;
    const placeholders = seenIds.map(() => '?').join(',');
    const res = this.db
      .prepare(
        `UPDATE listings SET delisted_at = ?
         WHERE source_id = ? AND delisted_at IS NULL AND id NOT IN (${placeholders})`,
      )
      .run(new Date().toISOString(), sourceId, ...seenIds);
    return res.changes;
  }

  search(f: SearchFilters = {}): Listing[] {
    const where: string[] = ['delisted_at IS NULL'];
    const params: Record<string, unknown> = {};

    if (f.make) { where.push('LOWER(make) = LOWER(@make)'); params.make = f.make; }
    if (f.model) { where.push('LOWER(model) LIKE LOWER(@model)'); params.model = `%${f.model}%`; }
    if (f.yearMin) { where.push('year >= @yearMin'); params.yearMin = f.yearMin; }
    if (f.yearMax) { where.push('year <= @yearMax'); params.yearMax = f.yearMax; }
    if (f.priceMin) { where.push('price >= @priceMin'); params.priceMin = f.priceMin; }
    if (f.priceMax) { where.push('price <= @priceMax'); params.priceMax = f.priceMax; }
    if (f.mileageMax) { where.push('mileage <= @mileageMax'); params.mileageMax = f.mileageMax; }
    if (f.bodyType) { where.push('LOWER(body_type) LIKE LOWER(@bodyType)'); params.bodyType = `%${f.bodyType}%`; }
    if (f.fuelType) { where.push('LOWER(fuel_type) LIKE LOWER(@fuelType)'); params.fuelType = `%${f.fuelType}%`; }
    if (f.text) { where.push('LOWER(title) LIKE LOWER(@text)'); params.text = `%${f.text}%`; }
    if (f.priceKinds?.length) {
      where.push(`price_kind IN (${f.priceKinds.map((_, i) => `@pk${i}`).join(',')})`);
      f.priceKinds.forEach((k, i) => { params[`pk${i}`] = k; });
    }
    if (f.sourceIds?.length) {
      where.push(`source_id IN (${f.sourceIds.map((_, i) => `@src${i}`).join(',')})`);
      f.sourceIds.forEach((s, i) => { params[`src${i}`] = s; });
    }

    let facetParam = 0;
    const bindFacet = (v: unknown) => {
      const name = `fc${facetParam++}`;
      params[name] = typeof v === 'boolean' ? (v ? 1 : 0) : (v as string | number);
      return `@${name}`;
    };
    for (const pred of buildFacetPredicates(f.facets, bindFacet)) where.push(pred.sql);
    const order =
      f.sort === 'mileage' ? 'mileage ASC'
      : f.sort === 'year' ? 'year DESC'
      : f.sort === 'newest' ? 'first_seen DESC'
      : f.sort === 'days-on-market' ? 'first_seen ASC'
      : 'price ASC';

    const rows = this.db
      .prepare(
        `SELECT * FROM listings WHERE ${where.join(' AND ')}
         ORDER BY ${order} LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: f.limit ?? 200, offset: f.offset ?? 0 }) as Record<string, unknown>[];

    return rows.map(rowToListing);
  }

  /**
   * Comparable completed sales for a vehicle. This is the number no incumbent
   * shows: every one of them displays asking prices only.
   */
  facetCoverage(f: SearchFilters = {}): FacetCoverage[] {
    const where: string[] = ['delisted_at IS NULL'];
    const params: unknown[] = [];
    const p = (v: unknown) => { params.push(v); return '?'; };
    if (f.make) where.push(`LOWER(make) = LOWER(${p(f.make)})`);
    if (f.model) where.push(`LOWER(model) LIKE LOWER(${p(`%${f.model}%`)})`);
    if (f.priceKinds?.length) where.push(`price_kind IN (${f.priceKinds.map((k) => p(k)).join(',')})`);
    const scope = where.join(' AND ');

    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM listings WHERE ${scope}`).get(...params) as { n: number }).n;
    const knownSelect = FACETS.map((x) => `COUNT(${x.column}) AS "${x.key}"`).join(', ');
    const known = this.db.prepare(`SELECT ${knownSelect} FROM listings WHERE ${scope}`).get(...params) as Record<string, number>;

    return FACETS.map((def) => {
      const base: FacetCoverage = {
        key: def.key, column: def.column, label: def.label, group: def.group, kind: def.kind,
        unit: def.unit, hint: def.hint, strict: Boolean(def.strict),
        known: known[def.key] ?? 0, total,
      };
      if (base.known === 0) return base;
      if (def.kind === 'number') {
        const r = this.db.prepare(`SELECT MIN(${def.column}) AS lo, MAX(${def.column}) AS hi FROM listings WHERE ${scope}`)
          .get(...params) as { lo: number | null; hi: number | null };
        return { ...base, min: r.lo, max: r.hi };
      }
      const rows = this.db.prepare(
        `SELECT ${def.column} AS value, COUNT(*) AS n FROM listings
         WHERE ${scope} AND ${def.column} IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 40`,
      ).all(...params) as { value: string; n: number }[];
      return { ...base, values: rows.map((x) => ({ value: String(x.value), n: x.n })) };
    });
  }

  soldComps(make: string, model: string, yearMin: number, yearMax: number) {
    const rows = this.db
      .prepare(
        `SELECT price, year, mileage, event_date, source_id, title, url
         FROM listings
         WHERE price_kind = 'sold' AND price IS NOT NULL
           AND LOWER(make) = LOWER(?) AND LOWER(model) LIKE LOWER(?)
           AND year BETWEEN ? AND ?
         ORDER BY event_date DESC`,
      )
      .all(make, `%${model}%`, yearMin, yearMax) as {
        price: number; year: number; mileage: number | null; event_date: string | null;
        source_id: string; title: string; url: string | null;
      }[];

    if (rows.length === 0) return { count: 0, median: null, low: null, high: null, sales: [] };
    const prices = rows.map((r) => r.price).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    return {
      count: rows.length,
      median: prices.length % 2 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2,
      low: prices[0]!,
      high: prices[prices.length - 1]!,
      sales: rows.slice(0, 25),
    };
  }

  /**
   * Completed sale prices for a vehicle's peer group, used to rate deals.
   *
   * The year window is deliberately narrow. A 2017 and a 2021 of the same model
   * are different cars at different prices, and widening the window to gather a
   * bigger sample produces a median that describes neither.
   */
  soldPricesFor(make: string | null, model: string | null, year: number | null, yearWindow = 2): number[] {
    if (!make || !model || year === null) return [];
    const rows = this.db
      .prepare(
        `SELECT price FROM listings
         WHERE price_kind = 'sold' AND price IS NOT NULL
           AND LOWER(make) = LOWER(?) AND LOWER(model) LIKE LOWER(?)
           AND year BETWEEN ? AND ?`,
      )
      .all(make, `%${model}%`, year - yearWindow, year + yearWindow) as { price: number }[];
    return rows.map((r) => r.price);
  }

  /** Price history for one listing, which is where a price drop becomes visible. */
  priceHistory(listingId: string): { observedAt: string; price: number }[] {
    return this.db
      .prepare('SELECT observed_at as observedAt, price FROM price_points WHERE listing_id = ? ORDER BY observed_at')
      .all(listingId) as { observedAt: string; price: number }[];
  }

  daysOnMarket(listingId: string): number | null {
    const row = this.db.prepare('SELECT first_seen FROM listings WHERE id = ?').get(listingId) as
      | { first_seen: string }
      | undefined;
    if (!row) return null;
    return Math.floor((Date.now() - Date.parse(row.first_seen)) / 86400000);
  }

  cacheVinDecode(vin: string, decoded: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO vin_decodes (vin, decoded, fetched_at) VALUES (?, ?, ?)')
      .run(vin.toUpperCase(), JSON.stringify(decoded), new Date().toISOString());
  }

  getVinDecode<T>(vin: string): T | null {
    const row = this.db.prepare('SELECT decoded FROM vin_decodes WHERE vin = ?').get(vin.toUpperCase()) as
      | { decoded: string }
      | undefined;
    return row ? (JSON.parse(row.decoded) as T) : null;
  }

  stats() {
    const one = <T>(sql: string): T => this.db.prepare(sql).get() as T;
    return {
      listings: one<{ n: number }>('SELECT COUNT(*) as n FROM listings WHERE delisted_at IS NULL').n,
      delisted: one<{ n: number }>('SELECT COUNT(*) as n FROM listings WHERE delisted_at IS NOT NULL').n,
      withVin: one<{ n: number }>('SELECT COUNT(*) as n FROM listings WHERE vin IS NOT NULL').n,
      sold: one<{ n: number }>("SELECT COUNT(*) as n FROM listings WHERE price_kind = 'sold'").n,
      pricePoints: one<{ n: number }>('SELECT COUNT(*) as n FROM price_points').n,
      rejects: one<{ n: number }>('SELECT COUNT(*) as n FROM rejects').n,
      bySource: this.db
        .prepare('SELECT source_id, COUNT(*) as n FROM listings WHERE delisted_at IS NULL GROUP BY source_id ORDER BY n DESC')
        .all() as { source_id: string; n: number }[],
      rejectReasons: this.db
        .prepare('SELECT why, COUNT(*) as n FROM rejects GROUP BY why ORDER BY n DESC LIMIT 15')
        .all() as { why: string; n: number }[],
    };
  }
}

