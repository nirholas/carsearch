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


/**
 * The UK classic and enthusiast market. It publishes bare `Vehicle` nodes with
 * no list around them, which is what motivated reading standalone nodes at all.
 */
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
 * Three sources were probed with these and are deliberately NOT wired.
 *
 * Goo-net, Carsensor and PakWheels all ship a schema.org ItemList on their
 * search pages, and none of it is a car for sale. Goo-net's entries are links
 * to model categories, Carsensor's are a url and a photo with no name and no
 * price, and PakWheels' carry a title and a city but never an amount. An
 * adapter over any of them would run clean and store nothing, which is worse
 * than an unwired source because it looks like coverage. They need the listing
 * page or an endpoint, not this reader, and that is recorded in the registry so
 * the next person does not re-probe the same pages.
 */
