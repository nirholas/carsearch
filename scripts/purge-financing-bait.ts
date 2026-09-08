import { Pool } from 'pg';
import { isFinancingBait, isImpossiblePriceForAge } from '../src/core/normalize.js';

/**
 * Removes rows whose price is a down payment rather than the car's price.
 *
 * Buy-here-pay-here dealers post the financing term in the price field, so a
 * broad classifieds sweep filed a 2018 Mercedes C300 at $1,500. Unlike a
 * mislabelled model, there is nothing here worth keeping: the row's only
 * numeric fact is wrong, and a wrong price poisons every median, every deal
 * rating and every depreciation curve it lands in.
 *
 * The detector now runs during validation, so this only cleans what was
 * written before it existed. Run with --dry-run first.
 */

const dryRun = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: url });

const { rows } = await pool.query<{ id: string; title: string; price: number | null; year: number | null; source_id: string }>(
  'SELECT id, title, price, year, source_id FROM listings WHERE price IS NOT NULL',
);

const bait = rows.filter(
  (r) => isFinancingBait(r.title, r.price, r.year) || isImpossiblePriceForAge(r.title, r.price, r.year),
);
console.log(`${rows.length} priced listings, ${bait.length} carry a price that is not the car's`);

const bySource = new Map<string, number>();
for (const b of bait) bySource.set(b.source_id, (bySource.get(b.source_id) ?? 0) + 1);
for (const [src, n] of [...bySource].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${src}`);
for (const b of bait.slice(0, 8)) console.log(`   $${b.price?.toLocaleString()}  ${b.title.slice(0, 62)}`);

if (dryRun) {
  console.log('\ndry run, nothing deleted');
} else if (bait.length) {
  const res = await pool.query('DELETE FROM listings WHERE id = ANY($1::text[])', [bait.map((b) => b.id)]);
  console.log(`\ndeleted ${res.rowCount}`);
}
await pool.end();
