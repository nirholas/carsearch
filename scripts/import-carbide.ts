import { makeListing } from '../src/core/listing.js';
import { validate, parseMake, parseYear, resolveModel } from '../src/core/normalize.js';
import { facetsFromText } from '../src/enrich/text-facets.js';
import { openStore } from '../src/store/open.js';
import type { Listing } from '../src/core/types.js';

/**
 * Imports the corpus from the `carbide` prototype.
 *
 * That repository is a parallel, earlier attempt at the same product. Its code
 * is superseded by this one, but its crawl is not: it holds roughly five times
 * the listings and twice the completed auction sales, gathered over the same
 * days. Completed sales are the scarcest input this index has, and every
 * statistic on the market dashboard gets better with more of them.
 *
 * Read from the public repository rather than a local checkout so the import is
 * reproducible. Everything is put through the same normalization, plausibility
 * and dedupe path as a live crawl: an import is not a licence to skip the
 * checks that keep bad rows out.
 */

const BASE = 'https://raw.githubusercontent.com/nirholas/carbide/main/data';

interface CarbideListing {
  src: string; title: string; year: number | null; miles: number | null;
  price: number | null; loc: string | null; url: string; auction: boolean;
  make: string | null; model: string | null; dealer: string | null; id: string;
}

interface CarbideSold {
  title: string; price: number; date: string; url: string;
  line: string | null; year: number | null; miles: number | null;
}

/**
 * carbide labelled sources with display names. Ours are stable ids used in
 * listing keys, so they are mapped rather than slugified: a source whose id
 * drifts loses its price history.
 */
const SOURCE_IDS: Record<string, string> = {
  'Cars.com': 'carscom', CarMax: 'carmax', CarGurus: 'cargurus', Carvana: 'carvana',
  TrueCar: 'truecar', 'Cars & Bids': 'carsandbids', 'eBay Motors': 'ebaymotors',
  PrivateAuto: 'privateauto', hemc: 'hemmings', hem: 'hemmings', cmp: 'classiccom', somo: 'sothebysmotorsport',
};

/** Resolves the source from the destination host, which is the fact; the label is a hint. */
function sourceIdFor(row: CarbideListing): string {
  try {
    const host = new URL(row.url).hostname.replace(/^www\./, '');
    const byHost: Record<string, string> = {
      'cars.com': 'carscom', 'carmax.com': 'carmax', 'cargurus.com': 'cargurus',
      'carvana.com': 'carvana', 'truecar.com': 'truecar', 'carsandbids.com': 'carsandbids',
      'ebay.com': 'ebaymotors', 'privateauto.com': 'privateauto', 'hemmings.com': 'hemmings',
      'classiccars.com': 'classiccom', 'bringatrailer.com': 'bringatrailer',
      'sothebysmotorsport.com': 'sothebysmotorsport', 'rmsothebys.com': 'sothebysmotorsport',
    };
    const hit = Object.entries(byHost).find(([h]) => host === h || host.endsWith(`.${h}`));
    if (hit) return hit[1];
  } catch { /* fall through to the label */ }
  return SOURCE_IDS[row.src] ?? row.src.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const store = await openStore({ sqlitePath: process.env.CARSEARCH_DB ?? 'data/carsearch.db' });
await store.init();

const [rawListings, rawSold] = await Promise.all([
  json<CarbideListing[]>('listings.json'),
  json<CarbideSold[]>('sold.json'),
]);
console.log(`fetched ${rawListings.length} listings and ${rawSold.length} completed sales`);

const drafts: Listing[] = [];

for (const r of rawListings) {
  if (!r.url || !r.title) continue;
  const sourceId = sourceIdFor(r);
  const make = r.make && r.make !== 'Other' ? r.make : parseMake(r.title);
  // carbide's own ids are positional ("L0"), so the URL is the only stable key.
  const listing = makeListing({
    id: `${sourceId}:${r.url}`,
    sourceId,
    sourceListingId: null,
    url: r.url,
    title: r.title,
    year: r.year ?? parseYear(r.title),
    // "Other" was its normalizer giving up; ours re-reads the title.
    make,
    // Several sources repeat the make here, which poisons the peer group the
    // plausibility check is built on. resolveModel discards that and re-reads.
    model: resolveModel(r.title, make, r.model),
    price: r.price,
    priceKind: r.auction ? 'bid' : 'ask',
    mileage: r.miles,
    location: r.loc,
    sellerType: r.auction ? 'auction' : r.dealer ? 'dealer' : null,
    dealerName: r.dealer,
    raw: { via: 'carbide-import', originalSource: r.src },
  });
  drafts.push({ ...listing, ...facetsFromText(listing) });
}

for (const r of rawSold) {
  if (!r.url || !r.price) continue;
  const listing = makeListing({
    id: `bringatrailer:${r.url}`,
    sourceId: 'bringatrailer',
    sourceListingId: r.url.split('/').filter(Boolean).pop() ?? null,
    url: r.url,
    title: r.title,
    year: r.year ?? parseYear(r.title),
    model: resolveModel(r.title, parseMake(r.title), r.line),
    price: r.price,
    priceKind: 'sold',
    mileage: r.miles,
    sellerType: 'auction',
    // carbide stored US-format dates; the index is ISO throughout.
    eventDate: toIso(r.date),
    raw: { via: 'carbide-import' },
  });
  drafts.push({ ...listing, ...facetsFromText(listing) });
}

function toIso(d: string): string | null {
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return Number.isFinite(Date.parse(d)) ? new Date(d).toISOString().slice(0, 10) : null;
}

/** Same gate a live crawl passes: a bad row does not become good by arriving as a file. */
const { kept, rejected } = validate(drafts);

const reasons = new Map<string, number>();
for (const r of rejected) reasons.set(r.why, (reasons.get(r.why) ?? 0) + 1);
console.log(`${kept.length} passed plausibility, ${rejected.length} rejected`);
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${n.toString().padStart(4)}  ${why}`);

const res = await store.upsertMany(kept);
console.log(`inserted ${res.inserted}, updated ${res.updated}, ${res.priceChanges} price changes`);

const stats = await store.stats();
console.log(`index now: ${stats.listings} listings, ${stats.sold} sold, ${stats.bySource.length} sources`);
console.log(stats.bySource.map((s) => `${s.source_id}=${s.n}`).join(' '));
await store.close();
