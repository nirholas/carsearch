import { openStore } from '../src/store/open.js';
import { enrichListing } from '../src/enrich/vpic.js';
import { facetsFromText } from '../src/enrich/text-facets.js';
import { FACETS } from '../src/core/facets.js';
import type { Listing } from '../src/core/types.js';

/**
 * Fills the facet columns on listings already in the index.
 *
 * Two free sources, no re-crawl needed:
 *   - NHTSA vPIC, for anything carrying a VIN. Cached decodes cost nothing at
 *     all; uncached ones are one request each against a public service.
 *   - The listing's own text, for the disclosures enthusiast sites write into
 *     the title rather than into a field.
 *
 * Every write is COALESCE-shaped in the store, so running this repeatedly can
 * only add detail, never erase it.
 */

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const store = await openStore({ sqlitePath: process.env.CARSEARCH_DB ?? 'data/carsearch.db' });
await store.init();

const all = await store.search({ priceKinds: ['ask', 'bid', 'sold'], limit: 100_000 });
console.log(`${all.length} listings in the index, ${all.filter((l) => l.vin).length} with a VIN`);

const before = await store.facetCoverage({});
const changed: Listing[] = [];
let vinHits = 0;
let textHits = 0;

for (const listing of all) {
  const fromText = facetsFromText(listing);
  const withText = Object.keys(fromText).length ? { ...listing, ...fromText } : listing;
  if (withText !== listing) textHits += 1;

  const enriched = listing.vin ? await enrichListing(withText, store) : withText;
  if (listing.vin && enriched !== withText) vinHits += 1;

  const differs = FACETS.some((f) => {
    const key = f.key as keyof Listing;
    return enriched[key] !== listing[key];
  }) || enriched.mileage !== listing.mileage;

  if (differs) changed.push(enriched);
}

console.log(`text yielded facets on ${textHits}, VIN decode on ${vinHits}; ${changed.length} listings to update`);

if (dryRun) {
  console.log('dry run, nothing written');
} else {
  const res = await store.upsertMany(changed);
  console.log(`wrote ${res.updated} updates`);
}

const after = await store.facetCoverage({});
const byKey = new Map(before.map((c) => [c.key, c.known]));
console.log('\ncoverage change:');
for (const c of after) {
  const was = byKey.get(c.key) ?? 0;
  if (c.known !== was) console.log(`  ${c.key.padEnd(16)} ${was} -> ${c.known} of ${c.total}`);
}
await store.close();
