import { Pool } from 'pg';
import { PlausibilityModel } from '../src/core/normalize.js';

/**
 * Removes listings whose price is impossible for the car, judged against the
 * WHOLE index rather than one crawl batch.
 *
 * validate() builds its peer groups from the listings in front of it, which is
 * right during a crawl and leaves a gap: the model needs MIN_PEERS before it
 * will judge anything, so a lone bogus row in a small batch has no cohort and is
 * kept. A 2026 Porsche 911 with 1,000 miles listed at $25,476 reached production
 * that way, against a peer median of $239,985, and surfaced at the top of a real
 * buyer's search for a Porsche under $30,000.
 *
 * The scope is deliberately narrow, because the obvious version of this script
 * is dangerous. Run index-wide with no source filter it flags 273 rows, of which
 * 117 are Copart: a $1,700 Audi on a salvage auction is not an error, it is the
 * entire point of that source. Craigslist private-party cars and collector lots
 * at Bring a Trailer break the same assumption from both directions.
 *
 * So a row must clear all of these to be removed:
 *
 *   - a RETAIL marketplace, where every car is a dealer asking a market price
 *   - no branded title, since a salvage car IS worth a fraction of its peers
 *   - not a live auction bid, which is below market until the auction ends
 *   - twelve model years old or newer, because an old cheap car is ordinary
 *   - under a QUARTER of its peer median, not the 35% the ingest guard uses
 *
 * On the live index that is one row. That is the correct number: this is a
 * scalpel for parse errors, not a tool for pruning cheap cars.
 *
 * Run with --dry-run first.
 */

const dryRun = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

/** Sources where every listing is a dealer asking a retail price. */
const RETAIL = new Set(['kbb', 'cargurus', 'carscom', 'carmax', 'carvana', 'dupontregistry', 'autotempest', 'truecar']);
const BRANDED = new Set(['rebuilt', 'salvage', 'flood', 'lemon', 'junk', 'parts-only', 'theft-recovery', 'hail']);
const MAX_AGE_YEARS = 12;
const FLOOR_RATIO = 0.25;

interface Row {
  id: string; make: string | null; model: string | null; year: number | null;
  price: number; price_kind: string; title_status: string | null; source_id: string; mileage: number | null;
}

async function main() {
  const pool = new Pool({ connectionString: url });
  const { rows } = await pool.query<Row>(
    'SELECT id, make, model, year, price, price_kind, title_status, source_id, mileage FROM listings WHERE price IS NOT NULL',
  );

  // The cohort is every unbranded listing in the index, so the median is real.
  const model = new PlausibilityModel();
  for (const r of rows) {
    if (BRANDED.has(r.title_status ?? '')) continue;
    model.observe({ make: r.make, model: r.model, year: r.year, price: r.price, priceKind: r.price_kind as 'ask' });
  }

  const thisYear = new Date().getFullYear();
  const doomed: { row: Row; median: number }[] = [];
  for (const r of rows) {
    if (!RETAIL.has(r.source_id)) continue;
    if (r.price_kind === 'bid') continue;
    if (BRANDED.has(r.title_status ?? '')) continue;
    if (r.year === null || thisYear - r.year > MAX_AGE_YEARS) continue;
    const med = model.median(r.make, r.model, r.year);
    if (med !== null && r.price < med * FLOOR_RATIO) doomed.push({ row: r, median: med });
  }

  console.log(`${rows.length} priced listings, ${doomed.length} implausible for their own cohort`);
  for (const { row: r, median } of doomed) {
    console.log(
      `  ${r.year} ${r.make} ${r.model} $${r.price.toLocaleString()} vs peer median ` +
        `$${Math.round(median).toLocaleString()} (${Math.round((100 * r.price) / median)}%) ${r.mileage ?? '?'}mi ${r.source_id}`,
    );
  }

  if (!dryRun && doomed.length) {
    await pool.query('DELETE FROM listings WHERE id = ANY($1)', [doomed.map((d) => d.row.id)]);
    console.log(`deleted ${doomed.length}`);
  } else {
    console.log(dryRun ? 'dry run, nothing written' : 'nothing to do');
  }
  await pool.end();
}
main();
