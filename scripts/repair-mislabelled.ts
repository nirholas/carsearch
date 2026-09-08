import { Pool } from 'pg';
import { parseMake, parseModel } from '../src/core/normalize.js';
import { loadVocabulary } from '../src/nl/vocabulary.js';

/**
 * Repairs rows whose recorded model contradicts their own title.
 *
 * A crawl that fell back to a site search which silently ignored the query
 * wrote real completed sales stamped with the model that had been asked for:
 * a 1966 Ford Mustang recorded as a Mercedes G-Class. That is the worst class
 * of bad data. It looks like a result, it ranks like one, and nothing about it
 * reads as an error.
 *
 * The rows themselves are genuine auction results and completed sales are the
 * scarcest thing this index holds, so they are repaired rather than deleted.
 * The title is the source's own words about the car and therefore the arbiter;
 * where it cannot settle the model, the model is set to null rather than
 * guessed, because a null is honest and a guess is another false label.
 *
 * Run with --dry-run first.
 */

const dryRun = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: url });
const vocab = loadVocabulary();

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const { rows } = await pool.query<{ id: string; title: string; make: string | null; model: string | null; source_id: string }>(
  'SELECT id, title, make, model, source_id FROM listings WHERE title IS NOT NULL AND model IS NOT NULL',
);

const repairs: { id: string; from: string; to: string | null; make: string | null; title: string }[] = [];

for (const r of rows) {
  const titleMake = parseMake(r.title);
  const make = titleMake ?? r.make;
  if (!make || !r.model) continue;

  /**
   * The make is repaired too, because a wrong make hides a wrong model: the
   * catalogue check below asks "does this make list this model", and a Shelby
   * Mustang recorded as a Mercedes-Benz passes it, since Mercedes really does
   * make a G-Class.
   */
  const makeWrong = titleMake !== null && r.make !== null && titleMake.toLowerCase() !== r.make.toLowerCase();

  // The model is fine if the title says it outright and the make agrees.
  if (!makeWrong && norm(r.title).includes(norm(r.model))) continue;

  /**
   * Or if this make's catalogue lists it. "1996 Mercedes-Benz G320" never says
   * "G-Class", but G-Class is a real Mercedes model, so that row is correct and
   * must not be touched.
   */
  const catalogue = vocab.models[make.toLowerCase()] ?? [];
  if (!makeWrong && catalogue.some((m) => norm(m) === norm(r.model!))) continue;

  // Neither the title nor the make's own catalogue supports it: it was imposed.
  const fixed = parseModel(r.title, make);
  if (fixed === r.model && !makeWrong) continue;
  repairs.push({ id: r.id, from: r.model, to: fixed, make: makeWrong ? titleMake : null, title: r.title });
}

console.log(`${rows.length} listings checked, ${repairs.length} carry a model neither the title nor the catalogue supports`);
const counts = new Map<string, number>();
for (const x of repairs) counts.set(x.from, (counts.get(x.from) ?? 0) + 1);
for (const [from, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${String(n).padStart(4)}  recorded as "${from}"`);
for (const x of repairs.slice(0, 10)) {
  const makeNote = x.make ? ` (make -> ${x.make})` : '';
  console.log(`   "${x.from}" -> ${x.to === null ? 'null' : `"${x.to}"`}${makeNote}   ${x.title.slice(0, 54)}`);
}

if (dryRun) {
  console.log('\ndry run, nothing written');
} else if (repairs.length) {
  for (const x of repairs) {
    await pool.query(
      'UPDATE listings SET model = $2, make = COALESCE($3, make) WHERE id = $1',
      [x.id, x.to, x.make],
    );
  }
  console.log(`\nrepaired ${repairs.length}`);
}
await pool.end();
