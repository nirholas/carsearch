import { adapterById } from '../src/sources/index.js';
import { fetchText } from '../src/transport/fetcher.js';
import { evaluateInPage, closeBrowser } from '../src/transport/browser.js';
import { validate } from '../src/core/normalize.js';
import type { AdapterContext, SearchQuery, Listing } from '../src/core/types.js';

/**
 * Runs live source adapters and prints what they return, writing nothing.
 *
 * The read API answers from the index, which is only as fresh as the last
 * crawl. This asks the sites themselves, so a listing that sold this morning
 * is absent and a listing posted this morning is present. It exists because
 * "is this car still for sale" is the one question a cached answer cannot be
 * trusted with, and because the database URL is a Secret Manager reference
 * that is not always reachable from a developer machine.
 */

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  args.set(k!, v.join('=') || 'true');
}

const query: SearchQuery = {
  make: args.get('make') ?? undefined,
  models: args.get('model') ? args.get('model')!.split(',') : undefined,
  yearMin: args.get('yearMin') ? Number(args.get('yearMin')) : undefined,
  yearMax: args.get('yearMax') ? Number(args.get('yearMax')) : undefined,
  priceMax: args.get('priceMax') ? Number(args.get('priceMax')) : undefined,
  mileageMax: args.get('mileageMax') ? Number(args.get('mileageMax')) : undefined,
  zip: args.get('zip') ?? undefined,
  keywords: args.get('keywords') ?? undefined,
  regions: args.get('regions') ? args.get('regions')!.split(',') : undefined,
  radius: args.get('radius') ? Number(args.get('radius')) : undefined,
};

const wanted = (args.get('sources') ?? 'autotempest,carscom,cargurus,kbb,carmax,carvana').split(',');

const ctx: AdapterContext = {
  fetchText: (url, opts) => fetchText(url, opts),
  evaluate: (url, fn, opts) => evaluateInPage(url, fn, opts),
  log: (m) => console.error(`  ${m}`),
};

const all: Listing[] = [];
for (const id of wanted) {
  const adapter = adapterById.get(id);
  if (!adapter) {
    console.error(`! ${id}: not a wired adapter`);
    continue;
  }
  const started = Date.now();
  try {
    const rows = await adapter.search(query, ctx);
    // The same plausibility gate the crawler uses, so this cannot report a car
    // the index itself would have thrown away.
    const { kept, rejected } = validate(rows);
    all.push(...kept);
    const why = rejected.length ? `, ${rejected.length} rejected` : '';
    console.error(`${id.padEnd(14)} ${String(kept.length).padStart(4)} of ${String(rows.length).padStart(4)}${why} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.error(`${id.padEnd(14)} FAILED after ${((Date.now() - started) / 1000).toFixed(1)}s: ${(e as Error).message.split('\n')[0]}`);
  }
}

await closeBrowser();
console.log(JSON.stringify(all, null, 0));
