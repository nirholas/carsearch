import type { SourceAdapter, SearchQuery } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { extractJsonLd, scalar, num, firstImage, type JsonLdNode } from './jsonld.js';
import { parseYear, isRoundedMileage, canonicalMake, canonicalModel } from '../core/normalize.js';
import { parseTransmission } from '../core/facets.js';

/**
 * JDMBUYSELL, the largest marketplace for cars imported under the 25-year rule.
 *
 * It is the one place most US importers list together: 57 sellers and 923 kei
 * trucks on the day it was wired, beside Skylines, Supras and every other JDM
 * import, which is a segment no mainstream source in this index carries because
 * none of these cars was ever sold new in the US.
 *
 * Every search page publishes its ads as schema.org `Product`+`Vehicle` nodes,
 * 96 to a page, with price, model year, brand, model, transmission, an odometer
 * with its unit, and the selling dealer's name. `?page=N` paginates and was
 * checked by listing ids, not by counts: pages 1 and 21 hold different ads.
 *
 * Three limits a caller should know, all measured:
 *
 *   - NO LOCATION. The ad nodes carry no address, and the only address in the
 *     page's JSON-LD is JDMBUYSELL's own office in Burnaby, BC. Reading "the
 *     first address on the page" puts every truck in Canada. Location is left
 *     null rather than guessed.
 *   - SOME SELLERS ARE STILL IN JAPAN. MITSUI Co., Ltd. lists from Uozu, Toyama,
 *     and its ad page separates "vehicle price" from "import & shipping". Those
 *     rows are the cheapest in the segment ($1,420 for a 1996 Minicab) because
 *     freight and customs are not in the number. The seller is recorded so a
 *     reader can tell, and the registry note names the case.
 *   - ODOMETERS ARE KILOMETRES. Every node on a sampled page was `KMT`, so the
 *     unit is converted rather than stored as miles.
 */

const ORIGIN = 'https://www.jdmbuysell.com';

/** A ceiling, not an expectation: the kei category ran to 39 pages. */
const MAX_PAGES = 45;

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Queries that name the segment rather than a badge, which is how kei trucks are searched. */
const KEI = /\b(kei|mini\s*truck|japanese\s+truck|jdm\s+truck)\b/i;

/** Where a query should start, or null when this source cannot answer it. */
export function searchPath(query: SearchQuery, model?: string): string | null {
  if (query.make && model) return `/for-sale/${slug(query.make)}/${slug(model)}/`;
  if (query.make) return `/for-sale/${slug(query.make)}/`;
  if (query.keywords && KEI.test(query.keywords)) return '/for-sale/kei-trucks/';
  return null;
}

/** schema.org odometers carry a UN/CEFACT unit; KMT is kilometres. */
export function odometerMiles(node: JsonLdNode): number | null {
  const raw = node.mileageFromOdometer as JsonLdNode | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const value = num(raw.value);
  if (value === null || value <= 0) return null;
  const unit = String(raw.unitCode ?? raw.unitText ?? '').toUpperCase();
  return unit === 'KMT' || /KM|KILOMET/.test(unit) ? Math.round(value * 0.621371) : value;
}

/** Every Vehicle node on a page, wherever the page nests it. */
export function vehicleAds(html: string): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const node = n as JsonLdNode;
    const types = ([] as unknown[]).concat(node['@type'] ?? []);
    if (types.includes('Vehicle') && typeof node.url === 'string') out.push(node);
    for (const v of Object.values(node)) walk(v);
  };
  walk(extractJsonLd(html));
  return out;
}

export function toDraft(ad: JsonLdNode, now: string): ListingDraft | null {
  const url = scalar(ad.url);
  const name = scalar(ad.name);
  const offer = (Array.isArray(ad.offers) ? ad.offers[0] : ad.offers) as JsonLdNode | undefined;
  const price = num(offer?.price);
  if (!url || !name || price === null || price <= 0) return null;
  if (offer?.availability && !/InStock/i.test(String(offer.availability))) return null;

  const brand = scalar((ad.brand as JsonLdNode | undefined)?.name);
  const seller = scalar((offer?.seller as JsonLdNode | undefined)?.name);
  const miles = odometerMiles(ad);
  const id = url.replace(/\/$/, '').split('/').pop()!;

  return {
    id: `jdmbuysell:${id}`,
    sourceId: 'jdmbuysell',
    sourceListingId: id,
    url,
    title: name,
    year: num(ad.vehicleModelDate) ?? parseYear(name),
    make: canonicalMake(brand),
    model: canonicalModel(scalar(ad.model)),
    price,
    priceKind: 'ask',
    currency: (scalar(offer?.priceCurrency) ?? 'USD').toUpperCase(),
    mileage: miles,
    mileageIsRounded: isRoundedMileage(miles),
    location: null,
    sellerType: seller ? 'dealer' : 'private',
    dealerName: seller,
    transmission: parseTransmission(scalar(ad.vehicleTransmission)),
    imageUrl: firstImage(ad),
    firstSeen: now,
    lastSeen: now,
    raw: { seller },
  };
}

export const jdmbuysell: SourceAdapter = {
  source: getSource('jdmbuysell')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    const models = query.models?.length ? query.models : [undefined];

    for (const model of models) {
      const path = searchPath(query, model);
      if (!path) {
        ctx.log('jdmbuysell: needs a make, or keywords naming kei or mini trucks');
        return [];
      }

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const url = `${ORIGIN}${path}${page > 1 ? `?page=${page}` : ''}`;
        let ads: JsonLdNode[];
        try {
          const res = await fetchWithTls(url, { headers: { accept: 'text/html' } }, { browser: 'chrome' });
          if (res.status !== 200) {
            ctx.log(`jdmbuysell ${path} p${page}: HTTP ${res.status}`);
            break;
          }
          ads = vehicleAds(res.body);
        } catch (e) {
          ctx.log(`jdmbuysell ${path} p${page} FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }
        if (ads.length === 0) break;

        const before = out.size;
        for (const ad of ads) {
          const draft = toDraft(ad, now);
          if (draft && !out.has(draft.id)) out.set(draft.id, draft);
        }
        ctx.log(`jdmbuysell ${path.padEnd(28)} p${page} ${String(ads.length).padStart(3)} ads (pool ${out.size})`);
        // A pager that re-serves its last page would otherwise spin to the ceiling.
        if (out.size === before) break;
      }
    }

    return [...out.values()].map(makeListing);
  },
};
