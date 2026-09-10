import { jsonLdMarketplace } from './jsonld-marketplace.js';
import type { SearchQuery } from '../core/types.js';

/**
 * Marketplaces reached through the shared schema.org adapter.
 *
 * Every one of these was already in the registry as reachable and none of them
 * were being read, for two reasons that had nothing to do with the sites. The
 * unwired sweep probes homepages, and a homepage carries no inventory, so a
 * source whose search page ships a full ItemList scored zero and read as a dead
 * end. And the adapter only unwrapped ItemLists, so the sites that publish bare
 * `Vehicle` or `Product` nodes were invisible even when the page was fetched:
 * Car & Classic had 57 priced cars on it and reported none.
 *
 * Prices stay in the site's own currency. Converting would bake today's rate
 * into a permanent record and make a listing incomparable with itself later.
 */

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');


/** Canada's dominant marketplace, and the largest non-US English-language pool. */
export const autotraderca = jsonLdMarketplace({
  id: 'autotraderca',
  origin: 'https://www.autotrader.ca',
  currency: 'CAD',
  filtersByMake: true,
  url: (q: SearchQuery, model) => {
    const base = `https://www.autotrader.ca/cars/${q.make ? slug(q.make) : ''}${model ? `/${slug(model)}` : ''}`;
    const p = new URLSearchParams();
    if (q.priceMax) p.set('pRng', `,${q.priceMax}`);
    if (q.yearMin || q.yearMax) p.set('yRng', `${q.yearMin ?? ''},${q.yearMax ?? ''}`);
    return p.toString() ? `${base}/?${p}` : `${base}/`;
  },
});

/**
 * The UK classic and enthusiast market. It publishes bare `Vehicle` nodes with
 * no list around them, which is what motivated reading standalone nodes at all.
 */
export const carandclassic = jsonLdMarketplace({
  id: 'carandclassic',
  origin: 'https://www.carandclassic.com',
  currency: 'GBP',
  filtersByMake: true,
  url: (q: SearchQuery, model) => {
    const p = new URLSearchParams({ listing_type_ex: 'advert' });
    if (q.make) p.set('make', slug(q.make));
    if (model) p.set('model', slug(model));
    if (q.priceMax) p.set('price_to', String(q.priceMax));
    if (q.yearMin) p.set('year_from', String(q.yearMin));
    if (q.yearMax) p.set('year_to', String(q.yearMax));
    return `https://www.carandclassic.com/search?${p}`;
  },
});

/** The US classic market. Types its entries `"car"` in lower case. */
export const classiccars = jsonLdMarketplace({
  id: 'classiccars',
  origin: 'https://classiccars.com',
  currency: 'USD',
  filtersByMake: true,
  url: (q: SearchQuery, model) => {
    const years = q.yearMin || q.yearMax ? `${q.yearMin ?? 1900}-${q.yearMax ?? 2027}` : 'all-years';
    const make = q.make ? slug(q.make) : 'all-makes';
    return `https://classiccars.com/listings/find/${years}/${make}${model ? `/${slug(model)}` : ''}`;
  },
});

/** Latin America's largest marketplace, covering Argentina, Mexico and Brazil. */
export const mercadolibreautos = jsonLdMarketplace({
  id: 'mercadolibreautos',
  origin: 'https://autos.mercadolibre.com.ar',
  currency: 'ARS',
  filtersByMake: true,
  url: (q: SearchQuery, model) =>
    `https://autos.mercadolibre.com.ar/${slug(q.make ?? 'porsche')}${model ? `-${slug(model)}` : ''}/`,
});

/**
 * Pakistan's dominant marketplace.
 *
 * Recorded as unpriced on 2026-09-10 and that was a reading error, not the
 * site's. The search page publishes its results TWICE: 25 `ListItem` nodes that
 * carry a title and a city and no amount, and 18 `Product` nodes for the same
 * cars that carry `offers.price`. A reader that stopped at the list saw only the
 * half without money on it and concluded the site had none.
 *
 * The model segment is deliberately not sent. `mk_porsche/md_911/` answers 200
 * with a no-results page and zero JSON-LD, and so does every slug variant tried
 * (`md_porsche_911`, with and without `ct_all`), while the make page alone
 * carries the whole country's Porsche inventory. A national market this size
 * fits on one page, so asking for less only loses cars, and the model filter
 * downstream does the narrowing the URL cannot.
 */
export const pakwheels = jsonLdMarketplace({
  id: 'pakwheels',
  origin: 'https://www.pakwheels.com',
  currency: 'PKR',
  filtersByMake: true,
  url: (q: SearchQuery) =>
    `https://www.pakwheels.com/used-cars/search/-/mk_${slug(q.make ?? 'porsche').replace(/-/g, '_')}/`,
});

/**
 * Japan's two largest sites were probed with this reader and are NOT wired.
 *
 * Goo-net and Carsensor each answer 200 with over half a megabyte of real
 * inventory and a populated ItemList, which is exactly why they need saying out
 * loud: a probe that counts nodes calls them wired. Not one entry carries a
 * price, and the string `"price"` does not occur anywhere in either site's
 * JSON-LD, on a brand page or a model page. Goo-net's entries are links to model
 * CATEGORIES ("911, all") rather than cars, and Carsensor's are image galleries
 * with a detail URL and no name. An adapter over either would run clean and
 * store nothing, which is worse than no adapter because it looks like coverage.
 * Both need the detail page or an endpoint, not this reader.
 */
