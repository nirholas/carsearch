import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import type { Listing, RejectedListing, PriceKind } from '../core/types.js';
import type { DedupeGroup } from '../core/dedupe.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface SearchFilters {
  make?: string;
  model?: string;
  yearMin?: number;
  yearMax?: number;
  priceMin?: number;
  priceMax?: number;
  mileageMax?: number;
  priceKinds?: PriceKind[];
  sourceIds?: string[];
  bodyType?: string;
  fuelType?: string;
  text?: string;
  sort?: 'price' | 'mileage' | 'year' | 'newest' | 'days-on-market';
  limit?: number;
  offset?: number;
}

export class Store {
  private db: Database.Database;

  constructor(path = 'data/carsearch.db') {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
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

    this.db
      .prepare(
        `INSERT INTO listings (
           id, source_id, source_listing_id, url, title, year, make, model, trim, series,
           vin, price, price_kind, currency, mileage, mileage_is_rounded,
           location, seller_type, body_type, exterior_color, fuel_type,
           event_date, image_url, first_seen, last_seen, raw
         ) VALUES (
           @id, @sourceId, @sourceListingId, @url, @title, @year, @make, @model, @trim, @series,
           @vin, @price, @priceKind, @currency, @mileage, @mileageIsRounded,
           @location, @sellerType, @bodyType, @exteriorColor, @fuelType,
           @eventDate, @imageUrl, @firstSeen, @lastSeen, @raw
         )
         ON CONFLICT(id) DO UPDATE SET
           url = excluded.url, title = excluded.title, price = excluded.price,
           mileage = excluded.mileage, trim = excluded.trim, series = excluded.series,
           vin = COALESCE(excluded.vin, listings.vin),
           location = excluded.location, image_url = excluded.image_url,
           last_seen = excluded.last_seen, delisted_at = NULL, raw = excluded.raw`,
      )
      .run({
        id: l.id,
        sourceId: l.sourceId,
        sourceListingId: l.sourceListingId,
        url: l.url,
        title: l.title,
        year: l.year,
        make: l.make,
        model: l.model,
        trim: l.trim,
        series: l.series,
        vin: l.vin,
        price: l.price,
        priceKind: l.priceKind,
        currency: l.currency,
        mileage: l.mileage,
        mileageIsRounded: l.mileageIsRounded ? 1 : 0,
        location: l.location,
        sellerType: l.sellerType,
        bodyType: l.bodyType,
        exteriorColor: l.exteriorColor,
        fuelType: l.fuelType,
        eventDate: l.eventDate,
        imageUrl: l.imageUrl,
        firstSeen,
        lastSeen: now,
        raw: l.raw ? JSON.stringify(l.raw) : null,
      });

    const priceChanged = l.price !== null && existing?.price !== l.price;
    if (l.price !== null && (!existing || priceChanged)) {
      this.db
        .prepare('INSERT OR IGNORE INTO price_points (listing_id, observed_at, price) VALUES (?, ?, ?)')
        .run(l.id, now, l.price);
    }

    return { inserted: !existing, priceChanged: Boolean(priceChanged) };
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

function rowToListing(r: Record<string, unknown>): Listing {
  return {
    id: r.id as string,
    sourceId: r.source_id as string,
    sourceListingId: (r.source_listing_id as string) ?? null,
    url: (r.url as string) ?? null,
    title: r.title as string,
    year: (r.year as number) ?? null,
    make: (r.make as string) ?? null,
    model: (r.model as string) ?? null,
    trim: (r.trim as string) ?? null,
    series: (r.series as string) ?? null,
    vin: (r.vin as string) ?? null,
    price: (r.price as number) ?? null,
    priceKind: r.price_kind as PriceKind,
    currency: r.currency as string,
    mileage: (r.mileage as number) ?? null,
    mileageIsRounded: Boolean(r.mileage_is_rounded),
    location: (r.location as string) ?? null,
    sellerType: (r.seller_type as Listing['sellerType']) ?? null,
    bodyType: (r.body_type as string) ?? null,
    exteriorColor: (r.exterior_color as string) ?? null,
    fuelType: (r.fuel_type as string) ?? null,
    eventDate: (r.event_date as string) ?? null,
    imageUrl: (r.image_url as string) ?? null,
    firstSeen: r.first_seen as string,
    lastSeen: r.last_seen as string,
    raw: r.raw ? (JSON.parse(r.raw as string) as Record<string, unknown>) : undefined,
  };
}
