import pg from 'pg';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CarStore, SearchFilters, SoldComps, StoreStats, FacetCoverage } from './store.js';
import { FACETS } from '../core/facets.js';
import { buildFacetPredicates } from './filter.js';
import { INSERT_COLUMNS, insertValues, updateAssignments, rowToListing, postgresMigrations } from './columns.js';
import type { Listing, PriceKind, RejectedListing } from '../core/types.js';
import type { DedupeGroup } from '../core/dedupe.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * PostgreSQL storage, for anywhere the filesystem does not survive a deploy.
 *
 * This exists for one reason. Days-on-market and price-drop history are derived
 * by comparing each crawl against the last, so they can only ever be
 * accumulated, never reconstructed. On an ephemeral disk that dataset silently
 * resets to zero on every revision, and the failure is invisible: the site
 * still works, it just quietly forgets the only thing a competitor cannot
 * re-scrape.
 */
export class PostgresStore implements CarStore {
  readonly kind = 'postgres';
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      // Neon and Cloud SQL both terminate TLS with certificates the default
      // Node trust store does not always carry in a slim container image.
      ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(readFileSync(join(here, 'schema-pg.sql'), 'utf8'));
    // Facet columns are added here rather than only in the schema file, because
    // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists.
    for (const sql of postgresMigrations()) await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Upserts a batch and records a price point wherever the price moved.
   *
   * Done as one statement per listing inside a single transaction rather than
   * one giant multi-row insert, because the price-point write depends on the
   * previous price of that specific row and a bulk insert cannot see it.
   */
  async upsertMany(listings: Listing[]): Promise<{ inserted: number; updated: number; priceChanges: number }> {
    if (listings.length === 0) return { inserted: 0, updated: 0, priceChanges: 0 };
    const client = await this.pool.connect();
    let inserted = 0;
    let priceChanges = 0;
    try {
      await client.query('BEGIN');
      for (const l of listings) {
        const prev = await client.query<{ price: number | null }>(
          'SELECT price FROM listings WHERE id = $1',
          [l.id],
        );
        const existed = prev.rowCount! > 0;
        const priceChanged = l.price !== null && existed && prev.rows[0]!.price !== l.price;

        const cols = INSERT_COLUMNS;
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
        await client.query(
          `INSERT INTO listings (${cols.join(', ')}, first_seen, last_seen)
           VALUES (${placeholders}, NOW(), NOW())
           ON CONFLICT (id) DO UPDATE SET ${updateAssignments('listings')}, last_seen = NOW(), delisted_at = NULL`,
          insertValues(l),
        );

        if (!existed) inserted++;
        if (l.price !== null && (!existed || priceChanged)) {
          await client.query(
            'INSERT INTO price_points (listing_id, observed_at, price) VALUES ($1, NOW(), $2) ON CONFLICT DO NOTHING',
            [l.id, l.price],
          );
          if (priceChanged) priceChanges++;
        }

        /**
         * Dated prices the source published for days before we ever saw the
         * car. Seeded only on first insert: re-seeding on every crawl would
         * re-add points a purge had deliberately removed, and the primary key
         * already makes a repeat harmless rather than useful.
         */
        if (!existed && l.priceHistory?.length) {
          for (const point of l.priceHistory) {
            await client.query(
              'INSERT INTO price_points (listing_id, observed_at, price) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
              [l.id, point.observedAt, point.price],
            );
          }
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return { inserted, updated: listings.length - inserted, priceChanges };
  }

  async recordRejects(rejects: RejectedListing[]): Promise<void> {
    if (rejects.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of rejects) {
        await client.query(
          'INSERT INTO rejects (source_id, title, why, payload, observed_at) VALUES ($1,$2,$3,$4,NOW())',
          [r.sourceId, r.title ?? null, r.why, JSON.stringify(r)],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async saveGroups(groups: DedupeGroup[]): Promise<void> {
    if (groups.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const g of groups) {
        for (const m of g.members) {
          await client.query(
            `INSERT INTO vehicle_groups (group_id, listing_id, confidence, is_primary)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (group_id, listing_id) DO UPDATE SET confidence = EXCLUDED.confidence, is_primary = EXCLUDED.is_primary`,
            [g.primary.id, m.id, g.confidence, m.id === g.primary.id],
          );
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async recordRun(sourceId: string, ok: boolean, listings: number, rejected: number, durationMs: number, error?: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO source_runs (source_id, ran_at, ok, listings, rejected, duration_ms, error) VALUES ($1,NOW(),$2,$3,$4,$5,$6)',
      [sourceId, ok, listings, rejected, durationMs, error ?? null],
    );
  }

  async markDelisted(sourceId: string, seenIds: string[]): Promise<number> {
    if (seenIds.length === 0) return 0;
    const res = await this.pool.query(
      `UPDATE listings SET delisted_at = NOW()
       WHERE source_id = $1 AND delisted_at IS NULL AND NOT (id = ANY($2::text[]))`,
      [sourceId, seenIds],
    );
    return res.rowCount ?? 0;
  }

  async search(f: SearchFilters = {}): Promise<Listing[]> {
    const where: string[] = ['delisted_at IS NULL'];
    const params: unknown[] = [];
    const p = (v: unknown) => `$${params.push(v)}`;

    if (f.make) where.push(`LOWER(make) = LOWER(${p(f.make)})`);
    if (f.model) where.push(`LOWER(model) LIKE LOWER(${p(`%${f.model}%`)})`);
    if (f.yearMin) where.push(`year >= ${p(f.yearMin)}`);
    if (f.yearMax) where.push(`year <= ${p(f.yearMax)}`);
    if (f.priceMin) where.push(`price >= ${p(f.priceMin)}`);
    if (f.priceMax) where.push(`price <= ${p(f.priceMax)}`);
    if (f.mileageMax) where.push(`mileage <= ${p(f.mileageMax)}`);
    if (f.bodyType) where.push(`LOWER(body_type) LIKE LOWER(${p(`%${f.bodyType}%`)})`);
    if (f.fuelType) where.push(`LOWER(fuel_type) LIKE LOWER(${p(`%${f.fuelType}%`)})`);
    if (f.text) where.push(`LOWER(title) LIKE LOWER(${p(`%${f.text}%`)})`);
    if (f.priceKinds?.length) where.push(`price_kind = ANY(${p(f.priceKinds)}::text[])`);
    if (f.sourceIds?.length) where.push(`source_id = ANY(${p(f.sourceIds)}::text[])`);
    for (const pred of buildFacetPredicates(f.facets, p)) where.push(pred.sql);

    const order =
      f.sort === 'mileage' ? 'mileage ASC NULLS LAST'
      : f.sort === 'year' ? 'year DESC NULLS LAST'
      : f.sort === 'newest' ? 'first_seen DESC'
      : f.sort === 'days-on-market' ? 'first_seen ASC'
      : 'price ASC NULLS LAST';

    const res = await this.pool.query(
      `SELECT * FROM listings WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${p(f.limit ?? 200)} OFFSET ${p(f.offset ?? 0)}`,
      params,
    );
    return res.rows.map(rowToListing);
  }

  async facetCoverage(f: SearchFilters = {}): Promise<FacetCoverage[]> {
    const where: string[] = ['delisted_at IS NULL'];
    const params: unknown[] = [];
    const p = (v: unknown) => `$${params.push(v)}`;
    if (f.make) where.push(`LOWER(make) = LOWER(${p(f.make)})`);
    if (f.model) where.push(`LOWER(model) LIKE LOWER(${p(`%${f.model}%`)})`);
    if (f.priceKinds?.length) where.push(`price_kind = ANY(${p(f.priceKinds)}::text[])`);
    const scope = where.join(' AND ');

    const total = Number(
      (await this.pool.query(`SELECT COUNT(*)::int AS n FROM listings WHERE ${scope}`, params)).rows[0]!.n,
    );

    // One pass for every facet's known-count, rather than a query per facet.
    const knownSelect = FACETS.map((x) => `COUNT(${x.column})::int AS "${x.key}"`).join(', ');
    const known = (await this.pool.query(`SELECT ${knownSelect} FROM listings WHERE ${scope}`, params)).rows[0] as Record<string, number>;

    const out: FacetCoverage[] = [];
    for (const def of FACETS) {
      const base: FacetCoverage = {
        key: def.key, column: def.column, label: def.label, group: def.group, kind: def.kind,
        unit: def.unit, hint: def.hint, strict: Boolean(def.strict),
        known: known[def.key] ?? 0, total,
      };
      if (base.known === 0) { out.push(base); continue; }
      if (def.kind === 'number') {
        const r = (await this.pool.query(
          `SELECT MIN(${def.column}) AS lo, MAX(${def.column}) AS hi FROM listings WHERE ${scope}`, params)).rows[0]!;
        out.push({ ...base, min: r.lo === null ? null : Number(r.lo), max: r.hi === null ? null : Number(r.hi) });
      } else {
        const r = await this.pool.query(
          `SELECT ${def.column}::text AS value, COUNT(*)::int AS n FROM listings
           WHERE ${scope} AND ${def.column} IS NOT NULL
           GROUP BY 1 ORDER BY n DESC LIMIT 40`, params);
        out.push({ ...base, values: r.rows.map((x: { value: string; n: number }) => ({ value: x.value, n: Number(x.n) })) });
      }
    }
    return out;
  }

  async soldComps(make: string, model: string, yearMin: number, yearMax: number): Promise<SoldComps> {
    const res = await this.pool.query(
      `SELECT price, year, mileage, event_date, source_id, title, url
       FROM listings
       WHERE price_kind = 'sold' AND price IS NOT NULL
         AND LOWER(make) = LOWER($1) AND LOWER(model) LIKE LOWER($2)
         AND year BETWEEN $3 AND $4
       ORDER BY event_date DESC`,
      [make, `%${model}%`, yearMin, yearMax],
    );
    const rows = res.rows as SoldComps['sales'];
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

  async soldPricesFor(make: string | null, model: string | null, year: number | null, yearWindow = 2): Promise<number[]> {
    if (!make || !model || year === null) return [];
    const res = await this.pool.query<{ price: number }>(
      `SELECT price FROM listings
       WHERE price_kind = 'sold' AND price IS NOT NULL
         AND LOWER(make) = LOWER($1) AND LOWER(model) LIKE LOWER($2)
         AND year BETWEEN $3 AND $4`,
      [make, `%${model}%`, year - yearWindow, year + yearWindow],
    );
    return res.rows.map((r) => r.price);
  }

  async priceHistory(listingId: string) {
    const res = await this.pool.query<{ observedat: Date; price: number }>(
      'SELECT observed_at AS observedAt, price FROM price_points WHERE listing_id = $1 ORDER BY observed_at',
      [listingId],
    );
    return res.rows.map((r) => ({ observedAt: new Date(r.observedat).toISOString(), price: r.price }));
  }

  async daysOnMarket(listingId: string): Promise<number | null> {
    const res = await this.pool.query<{ first_seen: Date }>('SELECT first_seen FROM listings WHERE id = $1', [listingId]);
    const row = res.rows[0];
    if (!row) return null;
    return Math.floor((Date.now() - new Date(row.first_seen).getTime()) / 86400000);
  }

  async cacheVinDecode(vin: string, decoded: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO vin_decodes (vin, decoded, fetched_at) VALUES ($1,$2,NOW())
       ON CONFLICT (vin) DO UPDATE SET decoded = EXCLUDED.decoded, fetched_at = NOW()`,
      [vin.toUpperCase(), JSON.stringify(decoded)],
    );
  }

  async getVinDecode<T>(vin: string): Promise<T | null> {
    const res = await this.pool.query<{ decoded: T }>('SELECT decoded FROM vin_decodes WHERE vin = $1', [vin.toUpperCase()]);
    return res.rows[0]?.decoded ?? null;
  }

  async stats(): Promise<StoreStats> {
    const one = async (sql: string): Promise<number> => Number((await this.pool.query<{ n: string }>(sql)).rows[0]?.n ?? 0);
    const [listings, delisted, withVin, sold, pricePoints, rejects] = await Promise.all([
      one('SELECT COUNT(*) AS n FROM listings WHERE delisted_at IS NULL'),
      one('SELECT COUNT(*) AS n FROM listings WHERE delisted_at IS NOT NULL'),
      one('SELECT COUNT(*) AS n FROM listings WHERE vin IS NOT NULL'),
      one("SELECT COUNT(*) AS n FROM listings WHERE price_kind = 'sold'"),
      one('SELECT COUNT(*) AS n FROM price_points'),
      one('SELECT COUNT(*) AS n FROM rejects'),
    ]);
    const bySource = await this.pool.query<{ source_id: string; n: string }>(
      'SELECT source_id, COUNT(*) AS n FROM listings WHERE delisted_at IS NULL GROUP BY source_id ORDER BY n DESC',
    );
    const rejectReasons = await this.pool.query<{ why: string; n: string }>(
      'SELECT why, COUNT(*) AS n FROM rejects GROUP BY why ORDER BY n DESC LIMIT 15',
    );
    return {
      listings, delisted, withVin, sold, pricePoints, rejects,
      bySource: bySource.rows.map((r) => ({ source_id: r.source_id, n: Number(r.n) })),
      rejectReasons: rejectReasons.rows.map((r) => ({ why: r.why, n: Number(r.n) })),
    };
  }
}

