import { captureJson, closeBrowser } from '../src/transport/browser.js';

/**
 * Finds the JSON endpoint a listings site's own frontend calls.
 *
 * Wiring a single-page app by reading its rendered DOM is the worst option
 * available: it reads a projection of the data through hashed class names that
 * change on the next deploy. The endpoint underneath is the site's contract
 * with its own frontend, and it is richer and far more stable.
 *
 * Usage:
 *   npx tsx scripts/find-endpoint.ts <url> [--scroll] [--wait 8000]
 *
 * Prints every JSON response the page fetched, largest first, with the shape of
 * each so the array of listings is obvious.
 */

const url = process.argv[2];
if (!url) throw new Error('usage: find-endpoint.ts <url> [--scroll] [--wait <ms>]');

const waitIdx = process.argv.indexOf('--wait');
const waitMs = waitIdx > 0 ? Number(process.argv[waitIdx + 1]) : 8000;

const responses = await captureJson(url, { waitMs, scroll: process.argv.includes('--scroll') });
console.log(`${responses.length} JSON responses from ${url}\n`);

/** Walks a payload looking for the array that holds the listings. */
function arrays(value: unknown, path = '', depth = 0): { path: string; n: number; keys: string[] }[] {
  if (depth > 6 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    const first = value.find((v) => v && typeof v === 'object');
    return value.length
      ? [{ path: path || '(root)', n: value.length, keys: first ? Object.keys(first).slice(0, 14) : [] }]
      : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    arrays(v, path ? `${path}.${k}` : k, depth + 1),
  );
}

for (const r of responses.slice(0, 12)) {
  console.log(`${(r.bytes / 1024).toFixed(0).padStart(6)}kb  ${r.status}  ${r.url.slice(0, 120)}`);
  for (const a of arrays(r.body).filter((x) => x.n >= 5 && x.keys.length).slice(0, 4)) {
    console.log(`          ${String(a.n).padStart(4)} x ${a.path}`);
    console.log(`               ${a.keys.join(' ')}`);
  }
}
await closeBrowser();

/**
 * The request that produced each response, for the POST search APIs.
 *
 * A search endpoint is almost always a POST and the response alone does not say
 * what was asked for: the collection name, the queried fields and the filter
 * syntax exist only in the request body. Printing them is the difference
 * between finding an endpoint and being able to call it.
 */
for (const r of responses) {
  if (!r.request) continue;
  console.log(`\nrequest to ${r.url.split('?')[0]}`);
  console.log(r.request.slice(0, 4000));
  const headers = Object.entries(r.requestHeaders ?? {});
  if (headers.length) {
    console.log('  headers:', headers.map(([k, v]) => `${k}: ${v.slice(0, 80)}`).join('\n           '));
  }
}
