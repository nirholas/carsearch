import pLimit from 'p-limit';
import { openStore } from '../src/store/open.js';
import { enrichListing } from '../src/enrich/vpic.js';
import { enrichWithEpa, saveCache as saveEpaCache } from '../src/enrich/epa.js';
import { facetsFromText } from '../src/enrich/text-facets.js';
import { FACETS } from '../src/core/facets.js';
import type { Listing } from '../src/core/types.js';

/**
 * Fills the facet columns on listings already in the index.
 *
 * Two free sources, no re-crawl needed:
 *   - NHTSA vPIC, for anything carrying a VIN. Cached decodes cost nothing at
 *     all; uncached ones are one request each against a public service.
 *   - The EPA's fuel economy dataset, for anything with a year, make and model,
 *     which is nearly everything. Fuel economy, cylinders, displacement,
 *     transmission, drivetrain and electric range are properties of a MODEL
 *     rather than of a listing, so they can be looked up rather than crawled.
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
let epaHits = 0;
let done = 0;

/**
 * Bounded concurrency, because the model-level lookups dominate the runtime.
 *
 * Each distinct year/make/model costs up to three requests and the index holds
 * roughly fifteen hundred cohorts, which is twenty minutes sequentially and two
 * with a modest fan-out. The cap is deliberately low: these are free public
 * services and the only thanks they get is not being hammered.
 */
const limit = pLimit(8);

async function enrich(listing: Listing): Promise<void> {
  const fromText = facetsFromText(listing);
  const withText = Object.keys(fromText).length ? { ...listing, ...fromText } : listing;
  if (withText !== listing) textHits += 1;

  const decoded = listing.vin ? await enrichListing(withText, store) : withText;
  if (listing.vin && decoded !== withText) vinHits += 1;

  // Model-level facts last, so anything the listing or its VIN stated wins.
  const enriched = await enrichWithEpa(decoded);
  if (enriched !== decoded) epaHits += 1;

  const differs = FACETS.some((f) => {
    const key = f.key as keyof Listing;
    return enriched[key] !== listing[key];
  }) || enriched.mileage !== listing.mileage;

  if (differs) changed.push(enriched);

  done += 1;
  if (done % 500 === 0) console.log(`  ${done}/${all.length} examined, ${changed.length} to update`);
}

await Promise.all(all.map((l) => limit(() => enrich(l))));

console.log(`text yielded facets on ${textHits}, VIN decode on ${vinHits}, EPA on ${epaHits}; ${changed.length} listings to update`);
saveEpaCache();

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
saveEpaCache();
await store.close();
