import { createHash } from 'node:crypto';
import type { SourceAdapter, SearchQuery } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { extractJsonLd, itemListEntries, offerPrice, offerLocation, firstImage, scalar } from './jsonld.js';
import { parseYear, parseMake, parseModel, isRoundedMileage } from '../core/normalize.js';
import { mileageFromText, facetsFromText } from '../enrich/text-facets.js';

/**
 * Craigslist: the private-party supply nobody aggregates.
 *
 * This is the largest gap in the category. AutoTempest's own footer admits it
 * renders a link-out button for Craigslist rather than aggregating it, and so
 * does everyone else. Private sellers are also where the price gap lives:
 * a dealer prices against other dealers, a private seller prices against
 * whatever they remember paying.
 *
 * Reachable by plain HTTP with a browser TLS fingerprint, and every search page
 * publishes its results as a schema.org ItemList for search engines. That makes
 * this both the highest-value source to add and one of the cheapest, which is
 * an unusual combination and the reason it is wired before flashier ones.
 *
 * Craigslist is sharded by metro rather than searchable nationally, so coverage
 * is a question of how many sites are queried. The list below is the largest
 * markets by population; each is one request.
 */

/** Metro subdomains, largest markets first. Each is one request. */
const METROS = [
  'losangeles', 'newyork', 'chicago', 'houston', 'dallas', 'miami', 'atlanta',
  'phoenix', 'seattle', 'sfbay', 'sandiego', 'denver', 'boston', 'philadelphia',
  'washingtondc', 'detroit', 'minneapolis', 'portland', 'lasvegas', 'austin',
];

/**
 * Every Craigslist site in California, by region name as a caller would pass it.
 *
 * The national default reaches the eight largest US metros, which is exactly two
 * California sites. A buyer shopping the state wants all twenty-eight, and a kei
 * truck is precisely the kind of vehicle that is listed in Chico or Merced
 * rather than in Los Angeles.
 */
export const REGION_METROS: Record<string, string[]> = {
  CA: [
    'losangeles', 'sfbay', 'sandiego', 'orangecounty', 'inlandempire', 'sacramento',
    'fresno', 'bakersfield', 'ventura', 'santabarbara', 'santamaria', 'slo', 'monterey',
    'stockton', 'modesto', 'merced', 'visalia', 'hanford', 'goldcountry', 'chico',
    'redding', 'humboldt', 'mendocino', 'yubasutta', 'susanville', 'siskiyou',
    'palmsprings', 'imperial',
  ],
};

/** Metros queried per run. The whole list is a lot of requests for one search. */
const DEFAULT_METRO_LIMIT = 8;

/** Resolves a caller's regions to metro subdomains: a state code expands, a subdomain passes through. */
export function metrosFor(regions: string[] | undefined): string[] {
  if (!regions?.length) return METROS.slice(0, DEFAULT_METRO_LIMIT);
  return [...new Set(regions.flatMap((r) => REGION_METROS[r.toUpperCase()] ?? [r.toLowerCase()]))];
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * The real listing URL for each title on a results page.
 *
 * The ItemList carries no per-item link, and the adapter used to fill the gap
 * with a search for the title, which sends a buyer to a results page that may
 * no longer contain the car. The static result list the page ships for
 * non-JavaScript clients does carry the link, in the same order and under the
 * same title, so the two are joined here. Titles can repeat, so each maps to a
 * queue of links consumed in order.
 */
export function listingLinks(html: string): Map<string, string[]> {
  const links = new Map<string, string[]>();
  for (const m of html.matchAll(/<li class="cl-static-search-result"[^>]*title="([^"]*)"[\s\S]*?<a href="([^"]+)"/g)) {
    const title = decodeEntities(m[1] ?? '').trim();
    const href = m[2];
    if (!title || !href) continue;
    links.set(title, [...(links.get(title) ?? []), href]);
  }
  return links;
}

function searchUrl(metro: string, query: SearchQuery, term?: string): string {
  const p = new URLSearchParams();
  const terms = query.make ? [query.make, term].filter(Boolean).join(' ') : (term ?? '');
  if (terms) p.set('query', terms);
  p.set('hasPic', '1');
  // Craigslist's own numeric filters, so a national sweep is not filtered in memory.
  if (query.priceMin) p.set('min_price', String(query.priceMin));
  if (query.priceMax) p.set('max_price', String(query.priceMax));
  if (query.yearMin) p.set('min_auto_year', String(query.yearMin));
  if (query.yearMax) p.set('max_auto_year', String(query.yearMax));
  if (query.mileageMax) p.set('max_auto_miles', String(query.mileageMax));
  p.set('sort', 'priceasc');
  return `https://${metro}.craigslist.org/search/cta?${p}`;
}

export const craigslist: SourceAdapter = {
  source: getSource('craigslist')!,

  async search(query, ctx) {
    const out = new Map<string, ListingDraft>();
    /**
     * With a make, each model is a query. Without one, the keywords are: a buyer
     * looking for "kei truck" or "mini truck" is describing a segment rather
     * than a badge, and sellers title their posts the same way.
     */
    const terms: (string | undefined)[] = query.make
      ? (query.models?.length ? query.models : [undefined])
      : (query.keywords ? query.keywords.split('|').map((k) => k.trim()).filter(Boolean) : [undefined]);
    const metros = metrosFor(query.regions);

    for (const metro of metros) {
      for (const model of terms) {
        const url = searchUrl(metro, query, model);
        try {
          const res = await fetchWithTls(url);
          if (res.status !== 200) {
            ctx.log(`craigslist ${metro} HTTP ${res.status}`);
            continue;
          }

          const items = itemListEntries(extractJsonLd(res.body));
          const links = listingLinks(res.body);
          let kept = 0;
          let offTopic = 0;

          for (const item of items) {
            const title = scalar(item.name);
            const price = offerPrice(item);
            if (!title || price === null) continue;

            /**
             * Craigslist's search is a loose full-text match, so a query for a
             * Porsche 911 returns Preludes and Hummers from dealers whose posts
             * happen to contain the words. Those rows are correctly labelled,
             * so they are not wrong, but a search that asked for one make and
             * answered with another is not a result. Anything the title
             * contradicts is dropped and counted, so the log says how loose the
             * match was rather than hiding it.
             */
            if (query.make && !new RegExp(`\\b${query.make.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(title)) {
              offTopic += 1;
              continue;
            }

            /**
             * Craigslist's ItemList does not carry a per-item URL, so the id is
             * built from the metro and the listing's own fields. Two different
             * cars in one metro sharing a title, a price and a photo is not a
             * thing that happens; the same car reposted is, and this collapses
             * it, which is the behaviour we want.
             */
            const image = firstImage(item);
            const link = links.get(title.trim())?.shift() ?? null;
            // The posting id in the link is the listing's own identity, and it is
            // what collapses a truck that turns up in several neighbouring metros.
            const postingId = link?.match(/\/([A-Za-z0-9]{10,})(?:\.html)?$/)?.[1] ?? null;
            const key = postingId ?? `${metro}:${title}:${price}:${image ?? ''}`;
            const id = `craigslist:${createHash('sha1').update(key).digest('base64url').slice(0, 22)}`;
            if (out.has(id)) continue;

            const make = parseMake(title) ?? query.make ?? null;
            // Private-party titles state mileage in the body, not the heading;
            // whatever the heading does carry is worth reading.
            const miles = mileageFromText(title);

            /**
             * Read the facets out of the title before storing.
             *
             * Private sellers write into the heading exactly what dealer sites
             * never publish anywhere: "Clean Title", "1 OWNER", "no accidents",
             * "service records", "salvage title". Those three columns sat at
             * zero coverage across every dealer source in the index, and this
             * is the source that fills them.
             */
            const draft: ListingDraft = {
              id,
              sourceId: 'craigslist',
              sourceListingId: postingId,
              url: link ?? `https://${metro}.craigslist.org/search/cta?query=${encodeURIComponent(title)}`,
              title,
              year: parseYear(title),
              make,
              model: parseModel(title, make) ?? model ?? null,
              price,
              priceKind: 'ask',
              currency: 'USD',
              mileage: miles,
              mileageIsRounded: miles !== null && isRoundedMileage(miles),
              location: offerLocation(item),
              // Craigslist is overwhelmingly private-party, and the dealers on
              // it are already reachable through their own sites.
              sellerType: 'private',
              imageUrl: image,
              raw: { metro },
            };
            out.set(id, { ...draft, ...facetsFromText(makeListing(draft)) });
            kept += 1;
          }
          ctx.log(
            `craigslist ${metro.padEnd(14)} ${String(items.length).padStart(4)} items, ${kept} kept` +
            `${offTopic ? `, ${offTopic} off-topic` : ''} (pool ${out.size})`,
          );
        } catch (e) {
          ctx.log(`craigslist ${metro} FAILED: ${(e as Error).message.split('\n')[0]}`);
        }
      }
    }

    return [...out.values()].map(makeListing);
  },
};
