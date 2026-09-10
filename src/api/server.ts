import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { openStore } from '../store/open.js';
import type { SearchFilters } from '../store/store.js';
import { SOURCES, registryStats, ADAPTERS } from '../sources/index.js';
import { dedupe, dedupeStats } from '../core/dedupe.js';
import { rateListing } from '../core/rating.js';
import { titleRisk } from '../core/title-risk.js';
import { recallsFor } from '../enrich/recalls.js';
import { run } from '../pipeline.js';
import type { PriceKind } from '../core/types.js';
import { ask } from '../nl/index.js';
import { loadVocabulary } from '../nl/vocabulary.js';
import { rank, parseSortSpec, PRESETS, DEFAULT_SORT } from '../core/rank.js';
import { isRated } from '../core/rating.js';
import { parseFacetQuery, unknownQueryKeys, suggestKey } from '../store/filter.js';
import { FACETS, FACETS_BY_KEY, GROUP_LABELS } from '../core/facets.js';
import { analyzeMarket, valueAtMileage, forecastOwnership } from '../analytics/market.js';
import type { Listing } from '../core/types.js';

/**
 * Read API over the aggregated index.
 *
 * Searching the database is separate from crawling the sources on purpose. A
 * user's search must answer in milliseconds from what has already been
 * collected; crawling is a background job measured in minutes. Conflating the
 * two is what makes meta-search sites feel slow.
 */

/**
 * Storage is chosen by environment, not by build. DATABASE_URL means Postgres,
 * which is what production needs so that price history survives a deploy;
 * otherwise the local SQLite file, so a developer needs nothing running.
 */
const store = await openStore({ sqlitePath: process.env.CARSEARCH_DB ?? 'data/carsearch.db' });
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

app.get('/api/health', async (c) => c.json({ ok: true, ...(await store.stats()) }));

/**
 * Makes and models for the search form's selects.
 *
 * Served from the same vocabulary the natural-language parser uses, so the
 * dropdown and the sentence box can never disagree about what a model is
 * called.
 */
app.get('/api/vocabulary', (c) => {
  const v = loadVocabulary();
  return c.json({
    makes: v.makes.map((m) => m.replace(/\b\w/g, (ch) => ch.toUpperCase())),
    models: v.models,
  });
});

/** A real photo from the index, used as the landing background. */
app.get('/api/hero', async (c) => {
  const rows = await store.search({ priceKinds: ['sold', 'ask'], limit: 60, sort: 'newest' });
  const withPhoto = rows.filter((r) => r.imageUrl);
  const pick = withPhoto[Math.floor(Math.random() * withPhoto.length)];
  return c.json({
    imageUrl: pick?.imageUrl ?? null,
    title: pick?.title ?? null,
    price: pick?.price ?? null,
    priceKind: pick?.priceKind ?? null,
    sourceId: pick?.sourceId ?? null,
  });
});

app.get('/api/sources', (c) =>
  c.json({
    stats: registryStats(),
    wired: ADAPTERS.map((a) => a.source.id),
    sources: SOURCES,
  }),
);

/**
 * Title risk for a whole pool, cohorted in memory.
 *
 * Unlike the deal rating this needs asking prices, not sold ones, and the pool
 * already in hand is the right population: it is the set the user is looking
 * at, filtered the way they filtered it. No extra query, and MIN_COHORT
 * suppresses the flag by itself when a cohort is too thin to have a floor.
 *
 * TRIM IS PART OF THE KEY and removing it breaks this outright: a base Cayman
 * in a cohort of GT4s reads as 43% underpriced. See core/title-risk.ts.
 *
 * The year band is two wide because a facelift moves price more than a model
 * year does, and a one-year cohort on a slow seller is never big enough.
 */
function titleRiskAll(rows: Listing[]) {
  const cohortKey = (l: Listing) =>
    `${l.make ?? ''}|${l.model ?? ''}|${l.trim ?? '~base'}|${Math.floor((l.year ?? 0) / 2) * 2}`.toLowerCase();

  const prices = new Map<string, number[]>();
  for (const l of rows) {
    if (l.price === null || l.priceKind !== 'ask') continue;
    const key = cohortKey(l);
    let bucket = prices.get(key);
    if (!bucket) prices.set(key, (bucket = []));
    bucket.push(l.price);
  }

  return new Map(rows.map((l) => [l.id, titleRisk(l, prices.get(cohortKey(l)) ?? [])] as const));
}

/**
 * Search the index.
 *
 * Results come back grouped, not flat. The same car is listed on several sites
 * at once, and returning it once with the sites it appears on is both more
 * honest and more useful than inflating the count.
 */
/**
 * How many rows are pulled into memory to be ranked.
 *
 * Ranking is multi-criteria and computed over the whole candidate set, so the
 * pool must be the population, not a page of it: a percentile taken from rows
 * SQL already truncated by a different ordering is a percentile of the wrong
 * population, and the answer would change with the page size. The pool cap is
 * reported in the response so a truncated one is never silently presented as
 * complete.
 */
const RANK_POOL = 3000;

/**
 * Query parameters each endpoint owns, which must not also be read as facet
 * filters. Both lists name the columns the handler already applies explicitly,
 * so a value is never applied twice or, worse, applied as something other than
 * what the caller meant.
 */
const SEARCH_RESERVED = ['make', 'model', 'year', 'price', 'mileage', 'bodyType', 'fuelType', 'currency'] as const;

/**
 * Non-facet parameters each endpoint genuinely accepts. Anything outside these
 * and the facet registry is a mistake, and is answered as one.
 */
const SEARCH_CONTROLS = [
  'limit', 'offset', 'sort', 'q', 'priceKinds', 'sources',
  'yearMin', 'yearMax', 'priceMin', 'priceMax', 'mileageMax',
] as const;
const FACETS_CONTROLS = ['priceKinds'] as const;
const MARKET_CONTROLS = ['yearMin', 'yearMax'] as const;

/**
 * Refuses a request carrying a parameter nobody will read.
 *
 * parseFacetQuery skips what it does not recognise, which is right for it and
 * dangerous alone: a search for `models=Macan` (the parameter is `model`) had
 * the filter dropped in silence and answered with Panameras, Cayennes and a
 * 911, each presented as a Macan. A filter that vanishes is worse than one that
 * fails, because the caller believes the answer.
 *
 * Returns a 400 body naming every unknown key and, where the edit distance is
 * small enough to be sure, what was probably meant.
 */
function rejectUnknownParams(
  q: Record<string, string>,
  reserved: readonly string[],
  controls: readonly string[],
): { error: string; unknown: { param: string; didYouMean?: string }[] } | null {
  const unknown = unknownQueryKeys(q, reserved, controls);
  if (unknown.length === 0) return null;
  return {
    error:
      `Unknown query parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
      'The request was refused rather than answered without the filter.',
    unknown: unknown.map((param) => {
      const guess = suggestKey(param, reserved, controls);
      return guess ? { param, didYouMean: guess } : { param };
    }),
  };
}
const MARKET_RESERVED = ['make', 'model', 'year', 'mileage', 'currency'] as const;

/**
 * Currency the search compares in.
 *
 * Prices are stored as the seller quoted them, and nothing converts. That is
 * right for the record and fatal for a comparison: a Finn.no car at 719,434 NOK
 * is about $67,000, and letting it into a dollar-denominated result set makes
 * it a $719,000 car to every median, every deal rating and every Pareto
 * frontier it touches. So a search covers one currency, defaulting to the one
 * most of the index is in, and asking for another is explicit.
 */
const DEFAULT_CURRENCY = 'USD';

function filtersFrom(q: Record<string, string>): SearchFilters {
  const facets = parseFacetQuery(q, SEARCH_RESERVED);
  facets.currency ??= { in: [q.currency ?? DEFAULT_CURRENCY] };
  return {
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
    facets,
    priceKinds: q.priceKinds ? (q.priceKinds.split(',') as PriceKind[]) : ['ask'],
    sourceIds: q.sources ? q.sources.split(',') : undefined,
  };
}

/**
 * Deal ratings for a whole pool, with one sold-price lookup per cohort.
 *
 * Rating each listing independently issued one query per row, which was
 * tolerable at 200 rows and is not at 3000. Cars cluster hard into cohorts, so
 * memoizing on (make, model, year) turns thousands of queries into a few dozen.
 */
async function rateAll(rows: Listing[]) {
  const cache = new Map<string, Promise<number[]>>();
  const soldFor = (l: Listing) => {
    const key = `${l.make ?? ''}|${l.model ?? ''}|${l.year ?? ''}`.toLowerCase();
    let hit = cache.get(key);
    if (!hit) {
      hit = store.soldPricesFor(l.make, l.model, l.year);
      cache.set(key, hit);
    }
    return hit;
  };
  return new Map(await Promise.all(rows.map(async (l) => [l.id, rateListing(l, await soldFor(l))] as const)));
}

/**
 * Search the index.
 *
 * Results come back grouped, not flat. The same car is listed on several sites
 * at once, and returning it once with the sites it appears on is both more
 * honest and more useful than inflating the count.
 *
 * Ordering happens here rather than in SQL because the orderings that matter
 * are not columns. "Lowest mileage and lowest price" is a trade-off between two
 * objectives, and the answer to it is a Pareto frontier plus a blended score,
 * neither of which an ORDER BY can express. See core/rank.ts.
 */
/**
 * Counts what would have matched with each single constraint dropped.
 *
 * One query per relaxed constraint, and only ever on an empty result, so it
 * costs nothing on the path that returns cars. A constraint whose removal still
 * yields nothing is not the binding one and is left out of the report.
 */
async function explainEmpty(filters: SearchFilters): Promise<{
  relaxing: { constraint: string; wouldMatch: number }[];
  message: string;
} | null> {
  const candidates: { constraint: string; patch: Partial<SearchFilters> }[] = [];
  if (filters.priceMax !== undefined) candidates.push({ constraint: `priceMax ${filters.priceMax}`, patch: { priceMax: undefined } });
  if (filters.mileageMax !== undefined) candidates.push({ constraint: `mileageMax ${filters.mileageMax}`, patch: { mileageMax: undefined } });
  if (filters.yearMin !== undefined) candidates.push({ constraint: `yearMin ${filters.yearMin}`, patch: { yearMin: undefined } });
  if (filters.yearMax !== undefined) candidates.push({ constraint: `yearMax ${filters.yearMax}`, patch: { yearMax: undefined } });
  if (Object.keys(filters.facets ?? {}).length > 1) candidates.push({ constraint: 'the attribute filters', patch: { facets: { currency: filters.facets!.currency! } } });
  /**
   * Make and model are deliberately not relaxed. They are what the buyer came
   * for, not a constraint they might trade away, and dropping them produces the
   * least useful sentence available: an i8 search answered "dropping model i8
   * would match 200", which is every BMW in the index.
   */
  if (candidates.length === 0) return null;

  const relaxing: { constraint: string; wouldMatch: number }[] = [];
  for (const c of candidates) {
    const rows = await store.search({ ...filters, ...c.patch, sort: 'price', limit: 200, offset: 0 });
    if (rows.length > 0) relaxing.push({ constraint: c.constraint, wouldMatch: rows.length });
  }
  /**
   * Fewest matches first. Each entry is a real trade the buyer could make, and
   * the tightest one is the constraint actually doing the blocking, so it leads.
   */
  relaxing.sort((a, b) => a.wouldMatch - b.wouldMatch);

  const phrase = (r: { constraint: string; wouldMatch: number }) =>
    `${r.wouldMatch} ${r.wouldMatch === 1 ? 'car matches' : 'cars match'} without ${r.constraint}`;
  const message = relaxing.length === 0
    ? 'Nothing matches even with any single filter removed. This combination is far from the market.'
    : `No car satisfies every filter at once. ${relaxing.slice(0, 2).map(phrase).join('; ')}.`;
  return { relaxing, message };
}

app.get('/api/search', async (c) => {
  const q = c.req.query();
  const bad = rejectUnknownParams(q, SEARCH_RESERVED, SEARCH_CONTROLS);
  if (bad) return c.json(bad, 400);
  const filters = filtersFrom(q);
  const limit = Math.min(int(q.limit) ?? 200, 500);
  const offset = int(q.offset) ?? 0;

  const spec = parseSortSpec(q.sort);
  // The coarse SQL pre-order decides which rows survive the pool cap, so it is
  // set from the first requested dimension rather than left at its default.
  const primary = spec.terms[0]!.key;
  const sqlSort: SearchFilters['sort'] =
    primary === 'mileage' ? 'mileage'
    : primary === 'year' ? 'year'
    : primary === 'listed' ? 'newest'
    : primary === 'days-on-market' ? 'days-on-market'
    : 'price';

  const pool = await store.search({ ...filters, sort: sqlSort, limit: RANK_POOL, offset: 0 });
  const groups = dedupe(pool);
  const deals = await rateAll(groups.map((g) => g.primary));
  // Cohorted over the whole pool, not the page, so paging cannot change a flag.
  const titleRisks = titleRiskAll(pool);

  const rankInputs = groups.map((g) => {
    const deal = deals.get(g.primary.id);
    return {
      id: g.primary.id,
      price: g.primary.price,
      mileage: g.primary.mileage,
      year: g.primary.year,
      firstSeen: g.primary.firstSeen,
      daysOnMarket: daysBetween(g.primary.firstSeen, g.primary.lastSeen),
      dealPercent: deal && isRated(deal) ? deal.percentVsSold : null,
      group: g,
    };
  });

  const ranked = rank(rankInputs, q.sort);
  const page = ranked.ranked.slice(offset, offset + limit);

  /**
   * When nothing matched, say which constraint did it.
   *
   * An empty page is the least informative screen in the product and the most
   * common one on a specific search. A real buyer asked for a BMW i8 under
   * $40,000 with under 60,000 miles and got nothing, while the index held sixty
   * i8s in which every car under $40,000 had crossed 60,000 miles. The answer
   * they needed was sitting in the data: the two limits do not intersect in
   * this market. Relaxing each one in turn and counting is the cheapest way to
   * find that out, and it turns a dead end into the actual finding.
   */
  const relaxed = page.length === 0 ? await explainEmpty(filters) : null;

  return c.json({
    query: { ...filters, sort: q.sort ?? DEFAULT_SORT },
    ...(relaxed ? { noMatches: relaxed } : {}),
    sort: {
      label: ranked.label,
      terms: ranked.terms,
      ignored: ranked.ignored,
      /** Rows nothing else beats on every requested dimension at once. */
      frontierSize: ranked.frontierSize,
      options: Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })),
    },
    stats: {
      ...dedupeStats(pool, groups),
      matched: ranked.ranked.length,
      returned: page.length,
      offset,
      poolCap: RANK_POOL,
      /** True when the cap bit, so the ranking saw a truncated population. */
      poolTruncated: pool.length >= RANK_POOL,
      excludedForUnknown: describeUnknownExclusions(filters),
    },
    results: await Promise.all(
      page.map(async (r) => {
        const g = r.row.group;
        return {
          ...g.primary,
          daysOnMarket: await store.daysOnMarket(g.primary.id),
          priceHistory: await store.priceHistory(g.primary.id),
          alsoOn: g.sources.filter((x) => x !== g.primary.sourceId),
          matchConfidence: g.confidence,
          deal: deals.get(g.primary.id),
          /** Present only when the price is unexplained AND no source spoke. */
          titleRisk: titleRisks.get(g.primary.id)?.suspect ? titleRisks.get(g.primary.id) : undefined,
          rank: {
            score: Math.round(r.score * 1000) / 1000,
            /** 1 means undominated: nothing in the set is better on every axis. */
            paretoLayer: r.paretoLayer,
            reasons: r.reasons,
            unknown: r.unknown,
          },
        };
      }),
    ),
  });
});

/** Days between two ISO timestamps, floored, or null when either is unreadable. */
function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

/**
 * Which facet filters are dropping rows for having no value, rather than for
 * failing the test.
 *
 * This is the difference between "no clean-title cars matched" and "no listing
 * in the index states a title status at all", and a search UI that cannot tell
 * a user which of those happened is unusable on sparse data.
 */
function describeUnknownExclusions(filters: SearchFilters): string[] {
  const out: string[] = [];
  for (const [key, f] of Object.entries(filters.facets ?? {})) {
    const def = FACETS_BY_KEY.get(key);
    if (!def) continue;
    if (f.includeUnknown ?? !def.strict) continue;
    out.push(`${def.label} excludes listings that never state one`);
  }
  return out;
}

/**
 * What the index actually knows, per attribute.
 *
 * The search form is built from this rather than from a hardcoded list, so a
 * control is never offered as though it works when nothing carries the data.
 */
app.get('/api/facets', async (c) => {
  const q = c.req.query();
  const bad = rejectUnknownParams(q, SEARCH_RESERVED, FACETS_CONTROLS);
  if (bad) return c.json(bad, 400);
  const coverage = await store.facetCoverage({
    make: q.make,
    model: q.model,
    priceKinds: q.priceKinds ? (q.priceKinds.split(',') as PriceKind[]) : undefined,
  });
  return c.json({
    groups: GROUP_LABELS,
    facets: coverage,
    /** Enum vocabularies, so the UI offers the canonical value even at zero coverage. */
    vocabularies: Object.fromEntries(
      FACETS.filter((f) => f.values).map((f) => [f.key, f.values]),
    ),
  });
});

/**
 * The market dashboard for one model.
 *
 * Everything here that claims to be about VALUE is computed from completed
 * sales alone. Asking prices appear only where they are labelled as asks, and
 * the spread between the two is the headline, because it is the one number this
 * index can produce and no incumbent publishes.
 */
app.get('/api/market', async (c) => {
  const q = c.req.query();
  const yearMin = int(q.yearMin) ?? null;
  const yearMax = int(q.yearMax) ?? null;

  const marketFacets = parseFacetQuery(q, MARKET_RESERVED);
  // Same reason as search: a depreciation curve fitted across three currencies
  // is not a curve, it is three of them drawn on one axis.
  marketFacets.currency ??= { in: [q.currency ?? DEFAULT_CURRENCY] };

  const rows = await store.search({
    make: q.make,
    model: q.model,
    yearMin: yearMin ?? undefined,
    yearMax: yearMax ?? undefined,
    facets: marketFacets,
    priceKinds: ['ask', 'bid', 'sold'],
    limit: RANK_POOL,
  });

  const report = analyzeMarket(rows, {
    make: q.make ?? null, model: q.model ?? null, yearMin, yearMax,
  });

  const atMileage = int(q.mileage);
  return c.json({
    ...report,
    /** A price for one specific car, refused rather than guessed out of range. */
    valuation: atMileage === undefined ? null : valueAtMileage(report.depreciation, atMileage),
    ownership: atMileage === undefined ? null : forecastOwnership(report.depreciation, atMileage, int(q.milesPerYear) ?? 10_000),
  });
});


/**
 * Completed sale prices.
 *
 * This is the endpoint no incumbent has. Every aggregator shows what sellers
 * are asking; this returns what buyers actually paid, with the spread between
 * the two.
 */
app.get('/api/comps', async (c) => {
  const { make, model } = c.req.query();
  if (!make || !model) return c.json({ error: 'make and model are required' }, 400);
  const yearMin = int(c.req.query('yearMin')) ?? 1990;
  const yearMax = int(c.req.query('yearMax')) ?? new Date().getFullYear() + 1;

  const sold = await store.soldComps(make, model, yearMin, yearMax);
  const asking = await store.search({ make, model, yearMin, yearMax, priceKinds: ['ask'], limit: 1000 });
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
  const found = (await store.search({ limit: 5000 })).find((l) => l.id === id);
  if (!found) return c.json({ error: 'not found' }, 404);

  const recalls =
    found.make && found.model && found.year ? await recallsFor(found.make, found.model, found.year) : null;

  return c.json({
    listing: found,
    priceHistory: await store.priceHistory(found.id),
    daysOnMarket: await store.daysOnMarket(found.id),
    recalls: recalls ? { count: recalls.count, parkIt: recalls.parkIt, parkOutSide: recalls.parkOutSide, campaigns: recalls.campaigns.slice(0, 5) } : null,
    comps: found.make && found.model && found.year
      ? await store.soldComps(found.make, found.model, found.year - 2, found.year + 2)
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

  const listings = await store.search({
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
    limit: RANK_POOL,
    sort: 'price',
  });
  const groups = dedupe(listings);
  const deals = await rateAll(groups.map((g) => g.primary));

  const ranked = rank(
    groups.map((g) => {
      const deal = deals.get(g.primary.id);
      return {
        id: g.primary.id,
        price: g.primary.price,
        mileage: g.primary.mileage,
        year: g.primary.year,
        firstSeen: g.primary.firstSeen,
        daysOnMarket: daysBetween(g.primary.firstSeen, g.primary.lastSeen),
        dealPercent: deal && isRated(deal) ? deal.percentVsSold : null,
        group: g,
      };
    }),
    q.sort,
  );
  const page = ranked.ranked.slice(0, body.limit ?? 200);

  return c.json({
    asked: text,
    understood: parsed.interpretation,
    parser: parsed.parser,
    query: { ...q, sort: q.sort ?? DEFAULT_SORT },
    sort: { label: ranked.label, terms: ranked.terms, frontierSize: ranked.frontierSize },
    stats: { ...dedupeStats(listings, groups), matched: ranked.ranked.length, returned: page.length },
    results: await Promise.all(
      page.map(async (r) => {
        const g = r.row.group;
        return {
          ...g.primary,
          daysOnMarket: await store.daysOnMarket(g.primary.id),
          alsoOn: g.sources.filter((x) => x !== g.primary.sourceId),
          deal: deals.get(g.primary.id),
          rank: { score: Math.round(r.score * 1000) / 1000, paretoLayer: r.paretoLayer, reasons: r.reasons, unknown: r.unknown },
        };
      }),
    ),
  });
});

/**
 * The auction view: live bids and completed sales, newest first.
 *
 * Kept as its own endpoint rather than a filter on search because auctions read
 * differently. A buyer scanning dealer inventory wants a dense list sorted by
 * price; someone following auctions wants a grid, a clock and a result.
 */
app.get('/api/auctions', async (c) => {
  const q = c.req.query();
  const rows = await store.search({
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
const stats = await store.stats();
/**
 * Bind on all interfaces, not just loopback.
 *
 * Cloud Run routes to the container's external interface and treats a
 * loopback-only listener as a failed start, and any port-forwarding tunnel
 * (Codespaces, ngrok, a dev container) cannot see one either. The default is
 * the one setting that works locally and nowhere else.
 */
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`carsearch listening on 0.0.0.0:${info.port}`);
  console.log(`index holds ${stats.listings} listings across ${stats.bySource.length} sources`);
});

export { app };
