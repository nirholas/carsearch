import { jsonLdMarketplace } from './jsonld-marketplace.js';

/**
 * European marketplaces reached through the shared schema.org adapter.
 *
 * All three publish a Car or Product ItemList for search engines, and all three
 * were invisible until the JSON-LD reader learned to descend into `mainEntity`.
 * Their prices stay in their own currency: converting would bake today's
 * exchange rate into a permanent record and make a Swedish listing
 * incomparable with itself six months later.
 */

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The largest European marketplace, covering eight countries from one domain. */
export const autoscout24 = jsonLdMarketplace({
  id: 'autoscout24',
  origin: 'https://www.autoscout24.com',
  currency: 'EUR',
  filtersByMake: true,
  url: (q, model) => {
    const make = q.make ? slug(q.make) : 'all';
    const base = `https://www.autoscout24.com/lst/${make}${model ? `/${slug(model)}` : ''}`;
    const p = new URLSearchParams();
    if (q.priceMax) p.set('priceto', String(q.priceMax));
    if (q.priceMin) p.set('pricefrom', String(q.priceMin));
    if (q.yearMin) p.set('fregfrom', String(q.yearMin));
    if (q.yearMax) p.set('fregto', String(q.yearMax));
    const qs = p.toString();
    return qs ? `${base}?${qs}` : base;
  },
});

/**
 * Norway's dominant marketplace. Its search is not narrowed by the make in the
 * URL without a numeric make id we do not hold, so it is crawled broadly and
 * every row keeps whatever brand it declares.
 */
export const finnno = jsonLdMarketplace({
  id: 'finnno',
  origin: 'https://www.finn.no',
  currency: 'NOK',
  filtersByMake: false,
  url: (q) => {
    const p = new URLSearchParams();
    if (q.make) p.set('q', q.make);
    if (q.priceMax) p.set('price_to', String(q.priceMax));
    if (q.yearMin) p.set('year_from', String(q.yearMin));
    return `https://www.finn.no/mobility/search/car${p.toString() ? `?${p}` : ''}`;
  },
});

/** Sweden's dominant classifieds site. Same shape, same caveat as Finn.no. */
export const blocket = jsonLdMarketplace({
  id: 'blocket',
  origin: 'https://www.blocket.se',
  currency: 'SEK',
  filtersByMake: false,
  url: (q) => {
    const p = new URLSearchParams();
    if (q.make) p.set('make', q.make);
    if (q.priceMax) p.set('price_max', String(q.priceMax));
    return `https://www.blocket.se/bilar/sok${p.toString() ? `?${p}` : ''}`;
  },
});
