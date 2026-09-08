import { SqliteStore } from '../src/store/sqlite-adapter.js';
import { PostgresStore } from '../src/store/postgres.js';

/**
 * Copies a local SQLite index into Postgres.
 *
 * Used once to seed production from a development crawl, and available
 * afterwards for the same job. Listings carry their own stable ids, so this is
 * idempotent: running it twice updates rather than duplicates.
 *
 * Price history is deliberately NOT copied. Each observation is timestamped
 * with when the crawl actually saw that price, and re-inserting them now would
 * stamp every one with today's date, inventing a history that never happened.
 * The production series starts clean from the first crawl that runs against it.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const src = new SqliteStore(process.env.SQLITE_PATH ?? 'data/carsearch.db');
await src.init();
const dst = new PostgresStore(url);
await dst.init();

const rows = await src.search({ limit: 100000, priceKinds: ['ask', 'sold', 'bid'] });
console.log(`read ${rows.length} listings from SQLite`);

const res = await dst.upsertMany(rows);
console.log('wrote', JSON.stringify(res));

const stats = await dst.stats();
console.log(`postgres now holds ${stats.listings} listings, ${stats.sold} sold, across ${stats.bySource.length} sources`);
console.log('by source:', stats.bySource.map((s) => `${s.source_id}=${s.n}`).join(' '));

await src.close();
await dst.close();
