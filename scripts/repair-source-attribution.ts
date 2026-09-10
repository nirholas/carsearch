import { Pool } from 'pg';
import { attribute, hostOf } from '../src/sources/autotempest.js';

/**
 * Repairs rows credited to a site their own link does not go to.
 *
 * AutoTempest tiles declare an origin in `data-backend-sitecode`, and the
 * crawler trusted that code outright. It disagrees with the href: 49 of 115
 * rows carrying the CarMax code linked to cars.com. Two things follow from a
 * wrong label, and both reach the buyer. The same car enters the index twice
 * under two ids at two prices, because the id is built from the source id; and
 * a `sources=carmax` search answers with a cars.com page, so the buyer is sent
 * somewhere the car is not.
 *
 * The listing itself is real, so it is relabelled rather than deleted. The id
 * carries the source id as its prefix and must be rewritten with it, which can
 * collide with the correctly-labelled copy already present. That collision IS
 * the duplicate, so the loser is dropped and its price history is moved onto
 * the survivor rather than thrown away.
 *
 * Run with --dry-run first.
 */

const dryRun = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: url });

const { rows } = await pool.query<{ id: string; source_id: string; url: string | null; raw: unknown }>(
  'SELECT id, source_id, url, raw FROM listings WHERE url IS NOT NULL',
);

interface Repair {
  id: string;
  newId: string;
  from: string;
  to: string;
  host: string;
}

const repairs: Repair[] = [];
for (const r of rows) {
  const host = hostOf(r.url);
  if (!host) continue;
  const code = (r.raw as { backendSiteCode?: string } | null)?.backendSiteCode ?? null;
  const correct = attribute(r.url, code);
  // Only a host we have actually mapped is allowed to overrule the stored id;
  // an unknown host means we do not know better, not that the row is wrong.
  if (correct === r.source_id || correct.startsWith('autotempest:')) continue;
  if (!r.id.startsWith(`${r.source_id}:`)) continue;
  repairs.push({
    id: r.id,
    newId: `${correct}:${r.id.slice(r.source_id.length + 1)}`,
    from: r.source_id,
    to: correct,
    host,
  });
}

const byMove = new Map<string, number>();
for (const r of repairs) byMove.set(`${r.from} -> ${r.to}`, (byMove.get(`${r.from} -> ${r.to}`) ?? 0) + 1);
console.log(`${rows.length} rows scanned, ${repairs.length} mislabelled`);
for (const [move, n] of [...byMove].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${move}`);
for (const r of repairs.slice(0, 10)) console.log(`  eg ${r.id} -> ${r.newId}  (${r.host})`);

if (dryRun || repairs.length === 0) {
  console.log(dryRun ? 'dry run, nothing written' : 'nothing to repair');
  await pool.end();
  process.exit(0);
}

/**
 * The id carries the source id as its prefix, so relabelling means changing a
 * primary key that `price_points` and `vehicle_groups` both reference with ON
 * DELETE CASCADE and no ON UPDATE. Updating the key in place is refused, and
 * deleting the row first takes its price history with it, which cannot be
 * backfilled. So the row is copied under its correct id, the children are moved
 * onto the copy, and only then does the original go, its cascade now empty.
 *
 * The column list is read from the database rather than written out here, so a
 * later migration cannot make this script silently drop a column.
 */
const columns = (
  await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'listings' AND table_schema = current_schema()
     ORDER BY ordinal_position`,
  )
).rows.map((r) => r.column_name);

const names = columns.map((c) => `"${c}"`).join(', ');
const values = columns
  .map((c) => (c === 'id' ? '$1' : c === 'source_id' ? '$2' : `"${c}"`))
  .join(', ');
const COPY_SQL = `INSERT INTO listings (${names}) SELECT ${values} FROM listings WHERE id = $3`;

let relabelled = 0;
let merged = 0;
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const r of repairs) {
    const taken = await client.query('SELECT 1 FROM listings WHERE id = $1', [r.newId]);
    if (taken.rowCount === 0) {
      await client.query(COPY_SQL, [r.newId, r.to, r.id]);
      await client.query('UPDATE price_points SET listing_id = $1 WHERE listing_id = $2', [r.newId, r.id]);
      // A group can already hold both copies, and (group_id, listing_id) is the
      // primary key there, so drop the colliding membership before moving the rest.
      await client.query(
        `DELETE FROM vehicle_groups o
         WHERE o.listing_id = $2
           AND EXISTS (SELECT 1 FROM vehicle_groups n WHERE n.listing_id = $1 AND n.group_id = o.group_id)`,
        [r.newId, r.id],
      );
      await client.query('UPDATE vehicle_groups SET listing_id = $1 WHERE listing_id = $2', [r.newId, r.id]);
      await client.query('DELETE FROM listings WHERE id = $1', [r.id]);
      relabelled += 1;
      continue;
    }
    // The correctly-labelled copy already exists, and that collision IS the
    // duplicate this bug created. Price history cannot be backfilled, so it is
    // folded onto the survivor before the duplicate goes.
    await client.query(
      `INSERT INTO price_points (listing_id, observed_at, price)
       SELECT $1, observed_at, price FROM price_points WHERE listing_id = $2
       ON CONFLICT (listing_id, observed_at) DO NOTHING`,
      [r.newId, r.id],
    );
    await client.query('DELETE FROM listings WHERE id = $1', [r.id]);
    merged += 1;
  }
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
}

console.log(`relabelled ${relabelled}, merged ${merged} into the copy that was already correct`);
await pool.end();
