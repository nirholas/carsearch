import { Pool } from 'pg';
import { parseTransmission, parseDrivetrain } from '../src/core/facets.js';
import { canonicalModel } from '../src/core/normalize.js';

/**
 * Corrects facet values already written to the index.
 *
 * The normal upsert writes facets with COALESCE, so a re-crawl can only add
 * detail and never erase it. That is right for the common case and wrong for
 * this one: when a PARSER was wrong, the bad value is already stored and
 * COALESCE will protect it forever. Repairs therefore go through direct
 * updates, and each one names the defect it is fixing.
 *
 * Run with --dry-run to see the counts before writing anything.
 */

const dryRun = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required: repairs run against the real index');

const pool = new Pool({ connectionString: url });

interface Repair {
  name: string;
  why: string;
  run(): Promise<number>;
}

const repairs: Repair[] = [
  {
    name: 'transmission from the cached VIN decode',
    why: 'NHTSA calls a PDK an "Automated Manual Transmission", which the parser read as a manual',
    async run() {
      const { rows } = await pool.query<{ vin: string; decoded: Record<string, string> }>(
        'SELECT vin, decoded FROM vin_decodes',
      );
      let n = 0;
      for (const r of rows) {
        const d = r.decoded ?? {};
        const t = parseTransmission(
          [d.TransmissionStyle, d.TransmissionSpeeds ? `${d.TransmissionSpeeds}-speed` : ''].join(' '),
        );
        const drive = parseDrivetrain(d.DriveType);
        if (!t && !drive) continue;
        const res = dryRun
          ? await pool.query(
              'SELECT COUNT(*)::int AS n FROM listings WHERE vin = $1 AND (transmission IS DISTINCT FROM $2 OR drivetrain IS DISTINCT FROM $3)',
              [r.vin, t, drive],
            )
          : await pool.query(
              'UPDATE listings SET transmission = COALESCE($2, transmission), drivetrain = COALESCE($3, drivetrain) WHERE vin = $1 AND (transmission IS DISTINCT FROM $2 OR drivetrain IS DISTINCT FROM $3)',
              [r.vin, t, drive],
            );
        n += dryRun ? (res.rows[0] as { n: number }).n : (res.rowCount ?? 0);
      }
      return n;
    },
  },
  {
    name: 'one spelling per model',
    why: '"Macan" and "macan" were two values, splitting every facet count, peer group and comps lookup',
    async run() {
      const { rows } = await pool.query<{ model: string }>(
        'SELECT DISTINCT model FROM listings WHERE model IS NOT NULL',
      );
      let n = 0;
      for (const r of rows) {
        const fixed = canonicalModel(r.model);
        if (fixed === r.model) continue;
        const res = dryRun
          ? await pool.query('SELECT COUNT(*)::int AS n FROM listings WHERE model = $1', [r.model])
          : await pool.query('UPDATE listings SET model = $2 WHERE model = $1', [r.model, fixed]);
        n += dryRun ? (res.rows[0] as { n: number }).n : (res.rowCount ?? 0);
      }
      return n;
    },
  },
  {
    name: 'blank strings are not values',
    why: 'an empty series rendered as its own facet value in the refine panel',
    async run() {
      const cols = ['series', 'trim', 'model', 'make', 'exterior_color', 'interior_color', 'engine', 'location'];
      let n = 0;
      for (const col of cols) {
        const res = dryRun
          ? await pool.query(`SELECT COUNT(*)::int AS n FROM listings WHERE TRIM(${col}) = ''`)
          : await pool.query(`UPDATE listings SET ${col} = NULL WHERE TRIM(${col}) = ''`);
        n += dryRun ? (res.rows[0] as { n: number }).n : (res.rowCount ?? 0);
      }
      return n;
    },
  },
];

console.log(dryRun ? 'DRY RUN, nothing will be written\n' : 'applying repairs\n');
for (const r of repairs) {
  const n = await r.run();
  console.log(`${dryRun ? 'would fix' : 'fixed'} ${String(n).padStart(5)}  ${r.name}`);
  console.log(`${' '.repeat(15)}${r.why}`);
}
await pool.end();
