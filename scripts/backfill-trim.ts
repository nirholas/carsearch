import { openStore } from '../src/store/open.js';
import { resolveTrim } from '../src/core/trim.js';
import type { Listing } from '../src/core/types.js';

/**
 * Fills `trim` on listings already in the index, from their own titles.
 *
 * `resolveTrim` runs inside `validate()` now, so anything crawled from here on
 * arrives with a trim. Everything already stored does not, and that is the
 * majority of the index: no re-crawl is needed because the variant is sitting
 * in the title string that was saved alongside it.
 *
 * This matters more than a display field. The cohort a car is compared against
 * is keyed on trim, and without it a 2016 Cayman GT4 and a base 2016 Cayman are
 * the same cohort. Their prices differ by a factor of two, so the lower
 * quartile lands in the middle of the GT4s and every base car in the group
 * reads as suspiciously cheap.
 *
 *   npx tsx scripts/backfill-trim.ts --dry-run
 *   npx tsx scripts/backfill-trim.ts
 */

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const store = await openStore({ sqlitePath: process.env.CARSEARCH_DB ?? 'data/carsearch.db' });
await store.init();

const all = await store.search({ priceKinds: ['ask', 'bid', 'sold'], limit: 100_000 });
const had = all.filter((l) => l.trim).length;
console.log(`${all.length} listings, ${had} already carry a trim`);

const changed: Listing[] = [];
const found = new Map<string, number>();

for (const l of all) {
  const trim = resolveTrim(l.title ?? '', l.make, l.model, l.trim);
  // Only ever adds. A source-stated trim is better evidence than a string
  // match, and resolveTrim already prefers it, but never let this clear one.
  if (!trim || trim === l.trim) continue;
  changed.push({ ...l, trim });
  found.set(trim, (found.get(trim) ?? 0) + 1);
}

console.log(`\n${changed.length} listings gain a trim. Most common:`);
for (const [t, n] of [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(n).padStart(5)}  ${t}`);
}

if (dryRun) {
  console.log('\ndry run, nothing written');
} else {
  const res = await store.upsertMany(changed);
  console.log(`\nwrote ${res.updated} updates`);
  const after = await store.search({ priceKinds: ['ask', 'bid', 'sold'], limit: 100_000 });
  const now = after.filter((l) => l.trim).length;
  console.log(`trim coverage ${had} -> ${now} of ${after.length} (${Math.round((now / after.length) * 100)}%)`);
}

await store.close();
