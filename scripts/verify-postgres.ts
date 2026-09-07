import { openStore } from '../src/store/open.js';
import type { Listing } from '../src/core/types.js';

/**
 * Exercises the PostgreSQL store against a real server.
 *
 * The Postgres implementation was written without ever being run: its upsert,
 * its price-point trigger condition, its array parameters and its JSONB columns
 * are all different from the SQLite ones. Shipping it unverified would mean the
 * first real execution happens in production, on the store that holds the one
 * dataset that cannot be rebuilt.
 */
const now = new Date().toISOString();
const mk = (id: string, price: number, priceKind: Listing['priceKind'], year: number): Listing => ({
  id, sourceId: 'verify', sourceListingId: id, url: null,
  title: `${year} Porsche Macan`, year, make: 'Porsche', model: 'Macan', trim: null, series: null,
  vin: null, price, priceKind, currency: 'USD', mileage: 40000, mileageIsRounded: false,
  location: null, sellerType: null, bodyType: null, exteriorColor: null, fuelType: null,
  eventDate: '2026-08-01', imageUrl: null, firstSeen: now, lastSeen: now,
  raw: { note: 'jsonb round trip' },
});

const s = await openStore();
console.log('connected and schema applied');

console.log('insert       ', JSON.stringify(await s.upsertMany([
  mk('t1', 30000, 'ask', 2017), mk('t2', 21000, 'sold', 2017),
  mk('t3', 22000, 'sold', 2017), mk('t4', 20000, 'sold', 2017),
])));
console.log('price change ', JSON.stringify(await s.upsertMany([mk('t1', 28000, 'ask', 2017)])));
console.log('history t1   ', (await s.priceHistory('t1')).map((h) => h.price));
console.log('search asks  ', (await s.search({ make: 'Porsche', priceKinds: ['ask'] })).map((r) => r.price));
console.log('raw jsonb    ', JSON.stringify((await s.search({ make: 'Porsche', priceKinds: ['ask'] }))[0]?.raw));
console.log('soldPricesFor', await s.soldPricesFor('Porsche', 'Macan', 2017));

const c = await s.soldComps('Porsche', 'Macan', 2015, 2019);
console.log('comps        ', `count=${c.count} median=${c.median} low=${c.low} high=${c.high}`);
console.log('daysOnMarket ', await s.daysOnMarket('t1'));

await s.cacheVinDecode('WP1AB2A56LLB33982', { Series: 'Type 95B' });
console.log('vin cache    ', JSON.stringify(await s.getVinDecode('WP1AB2A56LLB33982')));

console.log('delisted     ', await s.markDelisted('verify', ['t1', 't2', 't3']), 'marked (expect 1)');

const st = await s.stats();
console.log('stats        ', `${st.listings} live, ${st.delisted} delisted, ${st.sold} sold, ${st.pricePoints} price points`);
await s.close();
console.log('OK');
