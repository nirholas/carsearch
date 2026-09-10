import type { Listing, SearchQuery, SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { evaluateInPage } from '../transport/browser.js';
import { parseYear, parseMake, isRoundedMileage } from '../core/normalize.js';

/**
 * AutoTempest, used as a reachability multiplier rather than treated as a rival.
 *
 * One scrape here reaches Carvana and TrueCar, both of which refuse a plain
 * fetch AND a fully fingerprinted real browser. Every result tile also declares
 * its origin in `data-backend-sitecode`, so the listings arrive already
 * attributed and can be re-attributed to the true source rather than credited
 * to the aggregator.
 */

/** Origin codes observed on live result tiles, mapped to our own source ids. */
export const BACKEND_SITE_CODES: Record<string, string> = {
  cv: 'carvana',
  cm: 'carmax',
  cgu: 'cargurus',
  tc: 'truecar',
  eb: 'ebaymotors',
  cab: 'carsandbids',
  pa: 'privateauto',
  ct: 'carscom',
  at: 'autotrader',
  hm: 'hemmings',
  cx: 'carfax',
  cd: 'carsdirect',
  cs: 'carsoup',
};

/**
 * Destination hosts, mapped to our own source ids.
 *
 * The tile's `data-backend-sitecode` is AutoTempest's private taxonomy and it
 * does not always agree with where the link goes: 49 of 115 rows attributed to
 * CarMax by the `cm` code linked to cars.com, which put one car in the index
 * twice at two prices and sent a buyer to a CarMax page that did not exist.
 * The href cannot lie about where the car lives, so it is the authority and the
 * code is only a fallback for a host nobody has mapped yet.
 */
export const ORIGIN_HOSTS: Record<string, string> = {
  'carvana.com': 'carvana',
  'carmax.com': 'carmax',
  'cargurus.com': 'cargurus',
  'truecar.com': 'truecar',
  'ebay.com': 'ebaymotors',
  'carsandbids.com': 'carsandbids',
  'privateauto.com': 'privateauto',
  'cars.com': 'carscom',
  'autotrader.com': 'autotrader',
  'hemmings.com': 'hemmings',
  'carfax.com': 'carfax',
  'carsdirect.com': 'carsdirect',
  'carsoup.com': 'carsoup',
  'craigslist.org': 'craigslist',
  'bringatrailer.com': 'bringatrailer',
  'autotempest.com': 'autotempest',
};

/**
 * The source id a result belongs to.
 *
 * Host first, tile code second, and when neither is known the code is kept
 * namespaced (`autotempest:xyz`) so an unmapped origin is visible in the index
 * rather than silently credited to the aggregator.
 */
export function attribute(url: string | null, code: string | null): string {
  const host = hostOf(url);
  if (host) {
    const known = ORIGIN_HOSTS[host];
    if (known) return known;
  }
  if (code) return BACKEND_SITE_CODES[code] ?? `autotempest:${code}`;
  return 'autotempest';
}

/** Registrable host of a URL, without `www.`, or null when it will not parse. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

interface RawRow {
  title: string;
  price: number | null;
  miles: number | null;
  loc: string;
  code: string | null;
  id: string | null;
  url: string | null;
  auction: boolean;
  image: string | null;
}

/**
 * Runs inside the page, so it must be entirely self-contained.
 *
 * Prices are read from `.price-wrap` specifically, never by scanning tile text.
 * A loose scan for the first `$n,nnn` produced a "2026 Porsche 911 Targa 4 GTS
 * Cabriolet, 1,000 mi, $25,476" whose real comparables were over $185,000; the
 * number it found was a monthly payment. Note also that `.price` does not
 * exist on this markup, only `.price-wrap`.
 */
const EXTRACT = (): RawRow[] =>
  [...document.querySelectorAll('.result-list-item')].map((li) => {
    const sec = li.querySelector('section[data-backend-sitecode]');
    const txt = (el: Element | null): string => (el ? (el as HTMLElement).innerText.trim() : '');
    const num = (s: string): number | null => {
      const m = (s || '').replace(/,/g, '').match(/\$?\s*(\d{3,})/);
      return m && m[1] ? Number(m[1]) : null;
    };
    const a = li.querySelector('a.listing-link[href^="http"]') as HTMLAnchorElement | null;
    const img = li.querySelector('img[src^="http"]') as HTMLImageElement | null;
    return {
      title: txt(li.querySelector('.title-wrap, h2')).split('\n')[0] ?? '',
      price: num(txt(li.querySelector('.price-wrap'))),
      miles: num(txt(li.querySelector('.mileage'))),
      loc: txt(li.querySelector('.location .city, .location')).split('(')[0]?.trim() ?? '',
      code: sec ? sec.getAttribute('data-backend-sitecode') : null,
      id: sec ? sec.getAttribute('data-listing-id') : null,
      url: a ? a.href : null,
      auction: Boolean(li.querySelector('.description-badges__auction-badge')),
      image: img ? img.src : null,
    };
  });

function buildUrl(q: SearchQuery, model: string | undefined, sort: string): string {
  const p = new URLSearchParams();
  if (q.make) p.set('make', q.make.toLowerCase());
  if (model) p.set('model', model.toLowerCase());
  if (q.priceMax) p.set('maxprice', String(q.priceMax));
  if (q.priceMin) p.set('minprice', String(q.priceMin));
  if (q.yearMin) p.set('minyear', String(q.yearMin));
  if (q.yearMax) p.set('maxyear', String(q.yearMax));
  if (q.mileageMax) p.set('maxmiles', String(q.mileageMax));
  p.set('zip', q.zip ?? '90001');
  p.set('radius', q.radius === undefined ? 'any' : String(q.radius));
  p.set('sort', sort);
  return `https://www.autotempest.com/results?${p.toString()}`;
}

export const autotempest: SourceAdapter = {
  source: getSource('autotempest')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();

    /**
     * Per-model queries rather than one broad query. Each model gets its own
     * result quota, so six model queries returned around 250 unique cars where
     * a single broad make query returned 159 over identical filters.
     *
     * Two sorts per model for the same reason: the result set is capped, and
     * sorting by mileage and by price surfaces different tails of it.
     */
    const models = query.models?.length ? query.models : [undefined];
    const sorts = ['mileage', 'price'];

    for (const model of models) {
      for (const sort of sorts) {
        const url = buildUrl(query, model, sort);
        try {
          const rows = await evaluateInPage(url, EXTRACT, {
            settleSelector: '.result-list-item',
            stableChecks: 3,
            maxPolls: 14,
          });

          for (const r of rows) {
            if (!r.id) continue;
            const originSourceId = attribute(r.url, r.code);
            const id = `${originSourceId}:${r.id}`;
            if (out.has(id)) continue;
            out.set(id, {
              id,
              // Attributed to the site the car actually lives on, not to the aggregator.
              sourceId: originSourceId,
              sourceListingId: r.id,
              url: r.url,
              title: r.title,
              year: parseYear(r.title),
              make: parseMake(r.title) ?? query.make ?? null,
              model: model ?? null,
              trim: null,
              series: null,
              vin: null,
              price: r.price,
              // An auction tile shows the current bid, which is not an asking price.
              priceKind: r.auction ? 'bid' : 'ask',
              currency: 'USD',
              mileage: r.miles,
              mileageIsRounded: isRoundedMileage(r.miles),
              location: r.loc || null,
              sellerType: r.auction ? 'auction' : null,
              bodyType: null,
              exteriorColor: null,
              fuelType: null,
              eventDate: null,
              imageUrl: r.image,
              firstSeen: now,
              lastSeen: now,
              raw: { via: 'autotempest', backendSiteCode: r.code, sort, queryModel: model },
            });
          }
          ctx.log(`autotempest ${(model ?? 'all').padEnd(12)} ${sort.padEnd(8)} +${String(rows.length).padStart(3)} raw (pool ${out.size})`);
        } catch (e) {
          ctx.log(`autotempest ${model ?? 'all'} ${sort} FAILED: ${(e as Error).message.split('\n')[0]}`);
        }
      }
    }

    return [...out.values()].map(makeListing);
  },
};
