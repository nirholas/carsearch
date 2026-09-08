import { Pool } from 'pg';
import { canonicalBodyType, canonicalFuelType, canonicalColor, blankToNull } from '../src/core/canonical.js';

/**
 * Brings values already in the index up to one spelling each.
 *
 * validate() now canonicalizes on the way in, so this only repairs what was
 * written before it did. The upsert protects existing values with COALESCE,
 * which is right for filling gaps and useless for correcting them, so these go
 * in as direct updates.
 *
 * Run with --dry-run first.
 */

const dryRun = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: url });

const COLUMNS: [string, (v: string | null) => string | null][] = [
  ['body_type', canonicalBodyType],
  ['fuel_type', canonicalFuelType],
  ['exterior_color', canonicalColor],
  ['interior_color', canonicalColor],
  ['trim', blankToNull],
  ['series', blankToNull],
];

for (const [column, fn] of COLUMNS) {
  const { rows } = await pool.query<{ value: string | null; n: number }>(
    `SELECT ${column} AS value, COUNT(*)::int AS n FROM listings WHERE ${column} IS NOT NULL GROUP BY 1`,
  );
  const moves = rows
    .map((r) => ({ from: r.value!, to: fn(r.value), n: r.n }))
    .filter((m) => m.to !== m.from);

  const affected = moves.reduce((sum, m) => sum + m.n, 0);
  console.log(`${column.padEnd(16)} ${rows.length} distinct -> ${new Set(rows.map((r) => fn(r.value))).size} canonical, ${affected} rows change`);
  for (const m of moves.sort((a, b) => b.n - a.n).slice(0, 5)) {
    console.log(`    ${String(m.n).padStart(5)}  "${m.from}" -> ${m.to === null ? 'null' : `"${m.to}"`}`);
  }

  if (!dryRun) {
    for (const m of moves) {
      await pool.query(`UPDATE listings SET ${column} = $2 WHERE ${column} = $1`, [m.from, m.to]);
    }
  }
}

console.log(dryRun ? '\ndry run, nothing written' : '\napplied');
await pool.end();
