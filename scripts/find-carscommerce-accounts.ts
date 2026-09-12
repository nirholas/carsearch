import { captureJson, closeBrowser } from '../src/transport/browser.js';

/**
 * Finds Cars Commerce account ids, which is all a new rooftop costs.
 *
 * The listings API key is not account-scoped, so once any storefront has taught
 * the crawler a key, every other account on the platform is readable with just
 * its id. That makes account discovery the whole job: this loads a candidate's
 * inventory page, watches for the call its own frontend makes, and prints the
 * id and the size of the inventory behind it.
 *
 * Usage: npx tsx scripts/find-carscommerce-accounts.ts <host> [<host> ...]
 */

const SEARCH_HOST = 'websites-search.api.carscommerce.inc';
const PATHS = ['/used-inventory/index.htm', '/used-vehicles/', '/inventory/used/', '/all-inventory/index.htm'];

const hosts = process.argv.slice(2);
if (hosts.length === 0) throw new Error('usage: find-carscommerce-accounts.ts <host> [<host> ...]');

let key: string | null = null;

for (const host of hosts) {
  let found: { account: string; apiKey?: string } | null = null;
  for (const path of PATHS) {
    try {
      const responses = await captureJson(`${host}${path}`, { waitMs: 8000 });
      for (const r of responses) {
        if (!r.url.includes(SEARCH_HOST)) continue;
        const account = r.url.match(/\/listings\/(\d+)\/search/)?.[1];
        if (!account) continue;
        found = { account, apiKey: r.requestHeaders?.['x-api-key'] };
        key ??= found.apiKey ?? null;
        break;
      }
    } catch { /* a path this storefront does not have */ }
    if (found) break;
  }

  if (!found) { console.log(`${host.padEnd(42)} not on Cars Commerce`); continue; }

  let total = '?';
  if (key) {
    try {
      const res = await fetch(`https://${SEARCH_HOST}/api/v1/listings/${found.account}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key },
        body: JSON.stringify({
          page: 1, perPage: 1,
          filters: { status: ['publish', 'modified', 'pend-sale'] },
          facetFilters: { type_slug: ['Pre-Owned', 'Certified Pre-Owned'] },
          requestedFields: ['vin'],
        }),
      });
      const j = (await res.json()) as { meta?: { pagination?: { total?: number } } };
      total = String(j.meta?.pagination?.total ?? '?');
    } catch { /* the count is a nicety, the id is the point */ }
  }
  console.log(`${host.padEnd(42)} account ${found.account.padEnd(9)} ${total.padStart(6)} used cars`);
}

await closeBrowser();
