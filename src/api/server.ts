import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { Store, type SearchFilters } from '../store/db.js';
import { SOURCES, registryStats, ADAPTERS } from '../sources/index.js';
import { dedupe, dedupeStats } from '../core/dedupe.js';
import { rateListing } from '../core/rating.js';
import { recallsFor } from '../enrich/recalls.js';
import { run } from '../pipeline.js';
import type { PriceKind } from '../core/types.js';
import { ask } from '../nl/index.js';

/**
 * Read API over the aggregated index.
 *
 * Searching the database is separate from crawling the sources on purpose. A
 * user's search must answer in milliseconds from what has already been
 * collected; crawling is a background job measured in minutes. Conflating the
 * two is what makes meta-search sites feel slow.
 */

const store = new Store(process.env.CARSEARCH_DB ?? 'data/carsearch.db');
const app = new Hono();

app.use('/*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  await next();
});

const int = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

app.get('/api/health', (c) => c.json({ ok: true, ...store.stats() }));

app.get('/api/sources', (c) =>
  c.json({
    stats: registryStats(),
    wired: ADAPTERS.map((a) => a.source.id),
    sources: SOURCES,
  }),
);

/**
 * Search the index.
 *
 * Results come back grouped, not flat. The same car is listed on several sites
 * at once, and returning it once with the sites it appears on is both more
 * honest and more useful than inflating the count.
 */
app.get('/api/search', (c) => {
  const q = c.req.query();
  const filters: SearchFilters = {
    make: q.make,
    model: q.model,
    yearMin: int(q.yearMin),
    yearMax: int(q.yearMax),
    priceMin: int(q.priceMin),
    priceMax: int(q.priceMax),
    mileageMax: int(q.mileageMax),
    bodyType: q.bodyType,
    fuelType: q.fuelType,
    text: q.q,
    sort: (q.sort as SearchFilters['sort']) ?? 'price',
    limit: int(q.limit) ?? 200,
    offset: int(q.offset) ?? 0,
    priceKinds: q.priceKinds ? (q.priceKinds.split(',') as PriceKind[]) : ['ask'],
    sourceIds: q.sources ? q.sources.split(',') : undefined,
  };

  const listings = store.search(filters);
  const groups = dedupe(listings);

  return c.json({
    query: filters,
    stats: dedupeStats(listings, groups),
    results: groups.map((g) => ({
      ...g.primary,
      daysOnMarket: store.daysOnMarket(g.primary.id),
      priceHistory: store.priceHistory(g.primary.id),
      alsoOn: g.sources.filter((s) => s !== g.primary.sourceId),
      matchConfidence: g.confidence,
      deal: rateListing(g.primary, store.soldPricesFor(g.primary.make, g.primary.model, g.primary.year)),
    })),
  });
});

/**
 * Completed sale prices.
 *
 * This is the endpoint no incumbent has. Every aggregator shows what sellers
 * are asking; this returns what buyers actually paid, with the spread between
 * the two.
 */
app.get('/api/comps', (c) => {
  const { make, model } = c.req.query();
  if (!make || !model) return c.json({ error: 'make and model are required' }, 400);
  const yearMin = int(c.req.query('yearMin')) ?? 1990;
  const yearMax = int(c.req.query('yearMax')) ?? new Date().getFullYear() + 1;

  const sold = store.soldComps(make, model, yearMin, yearMax);
  const asking = store.search({ make, model, yearMin, yearMax, priceKinds: ['ask'], limit: 1000 });
  const askPrices = asking.map((a) => a.price).filter((p): p is number => p !== null).sort((a, b) => a - b);
  const askMedian = askPrices.length
    ? askPrices.length % 2
      ? askPrices[Math.floor(askPrices.length / 2)]!
      : (askPrices[askPrices.length / 2 - 1]! + askPrices[askPrices.length / 2]!) / 2
    : null;

  return c.json({
    make,
    model,
    years: [yearMin, yearMax],
    sold,
    asking: { count: askPrices.length, median: askMedian },
    // The number a buyer actually wants: how far above the market sellers are asking.
    spread: sold.median !== null && askMedian !== null ? Math.round(askMedian - sold.median) : null,
  });
});

app.get('/api/listing/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const [listing] = store.search({ limit: 1, text: undefined, ...({} as SearchFilters) }).filter((l) => l.id === id);
  const found = listing ?? store.search({ limit: 5000 }).find((l) => l.id === id);
  if (!found) return c.json({ error: 'not found' }, 404);

  const recalls =
    found.make && found.model && found.year ? await recallsFor(found.make, found.model, found.year) : null;

  return c.json({
    listing: found,
    priceHistory: store.priceHistory(found.id),
    daysOnMarket: store.daysOnMarket(found.id),
    recalls: recalls ? { count: recalls.count, parkIt: recalls.parkIt, parkOutSide: recalls.parkOutSide, campaigns: recalls.campaigns.slice(0, 5) } : null,
    comps: found.make && found.model && found.year
      ? store.soldComps(found.make, found.model, found.year - 2, found.year + 2)
      : null,
  });
});

/**
 * Natural-language search.
 *
 * Parses the sentence, then answers it from the index in the same call, so the
 * caller gets results rather than a query object it has to make a second
 * request with. The interpretation comes back alongside the results because a
 * search box that silently reinterprets the request is worse than one that
 * explains itself.
 */
app.post('/api/ask', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { q?: string; limit?: number };
  const text = (body.q ?? '').trim();
  if (!text) return c.json({ error: 'q is required' }, 400);

  const parsed = await ask(text);
  const q = parsed.query;

  const listings = store.search({
    make: q.make,
    model: q.models?.[0],
    yearMin: q.yearMin,
    yearMax: q.yearMax,
    priceMin: q.priceMin,
    priceMax: q.priceMax,
    mileageMax: q.mileageMax,
    bodyType: q.bodyType,
    fuelType: q.fuelType,
    text: q.keywords,
    priceKinds: q.priceKinds ?? ['ask'],
    limit: body.limit ?? 100,
    sort: 'price',
  });
  const groups = dedupe(listings);

  return c.json({
    asked: text,
    understood: parsed.interpretation,
    parser: parsed.parser,
    query: q,
    stats: dedupeStats(listings, groups),
    results: groups.map((g) => ({
      ...g.primary,
      daysOnMarket: store.daysOnMarket(g.primary.id),
      alsoOn: g.sources.filter((s) => s !== g.primary.sourceId),
      deal: rateListing(g.primary, store.soldPricesFor(g.primary.make, g.primary.model, g.primary.year)),
    })),
  });
});

/**
 * The auction view: live bids and completed sales, newest first.
 *
 * Kept as its own endpoint rather than a filter on search because auctions read
 * differently. A buyer scanning dealer inventory wants a dense list sorted by
 * price; someone following auctions wants a grid, a clock and a result.
 */
app.get('/api/auctions', (c) => {
  const q = c.req.query();
  const rows = store.search({
    make: q.make,
    model: q.model,
    yearMin: int(q.yearMin),
    yearMax: int(q.yearMax),
    priceKinds: ['sold', 'bid'],
    sort: 'newest',
    limit: int(q.limit) ?? 120,
  });
  const sold = rows.filter((r) => r.priceKind === 'sold');
  const live = rows.filter((r) => r.priceKind === 'bid');
  const prices = sold.map((s) => s.price).filter((p): p is number => p !== null).sort((a, b) => a - b);
  return c.json({
    live,
    sold: sold.sort((a, b) => (b.eventDate ?? '').localeCompare(a.eventDate ?? '')),
    summary: {
      soldCount: sold.length,
      liveCount: live.length,
      median: prices.length ? prices[Math.floor(prices.length / 2)] : null,
      low: prices[0] ?? null,
      high: prices[prices.length - 1] ?? null,
    },
  });
});

/** Triggers a live crawl. Slow by nature, so it reports rather than blocking a user's search. */
app.post('/api/crawl', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const logs: string[] = [];
  const result = await run({
    query: {
      make: body.make as string | undefined,
      models: Array.isArray(body.models) ? (body.models as string[]) : undefined,
      priceMax: body.priceMax as number | undefined,
      yearMin: body.yearMin as number | undefined,
      mileageMax: body.mileageMax as number | undefined,
      zip: (body.zip as string) ?? '90001',
    },
    store,
    sourceIds: Array.isArray(body.sources) ? (body.sources as string[]) : undefined,
    onLog: (m) => logs.push(m),
  });
  return c.json({ stats: result.stats, kept: result.listings.length, logs });
});

app.use('/*', serveStatic({ root: './web' }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`carsearch API on http://localhost:${info.port}`);
  console.log(`index holds ${store.stats().listings} listings across ${store.stats().bySource.length} sources`);
});

export { app };
