import type { SourceAdapter, SearchQuery, Listing } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { captureJson } from '../transport/browser.js';
import { isRoundedMileage, isValidVin } from '../core/normalize.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';
import { canonicalFuelType, canonicalBodyType, canonicalColor } from '../core/canonical.js';

/**
 * Dealer Inspire storefronts, read through the Cars Commerce listings API.
 *
 * A platform is worth far more than a site. Every Dealer Inspire storefront in
 * the country answers the same POST at
 * websites-search.api.carscommerce.inc/api/v1/listings/<account>/search, so
 * once this is wired the next dealer group costs a host and nothing else. Ken
 * Garff alone returns 5,711 used cars through it, across roughly seventy
 * rooftops that the group's own site treats as one inventory.
 *
 * Records arrive typed rather than scraped: VIN, trim, odometer, drivetrain,
 * engine, fuel, economy, the dealer's street address and the real vehicle
 * detail URL. That is better data than any marketplace tile carries, because it
 * is the dealer's own feed rather than a rendering of it.
 *
 * The account id and the API key both live in a JavaScript bundle rather than
 * the HTML, so they are learned by watching one page load and then cached: one
 * browser visit buys hundreds of fast API pages. An API answering 401 "No API
 * key found in request" to a correctly shaped body is what this exists to
 * avoid, and it is why the request headers are captured and not just the body.
 */

const SEARCH_HOST = 'websites-search.api.carscommerce.inc';

/**
 * Where a storefront keeps its used inventory.
 *
 * Dealer Inspire does not impose one path. Ken Garff answers at
 * /used-inventory/index.htm and Koons does not have that page at all, so
 * assuming a single route reads as "this is not a Dealer Inspire site" when it
 * plainly is. These are tried in order until one actually calls the listings
 * API, which is the only proof that matters.
 */
const INVENTORY_PATHS = [
  '/used-inventory/index.htm',
  '/used-vehicles/',
  '/searchused.aspx',
  '/inventory/used/',
  '/all-inventory/index.htm',
  '/used-cars/',
];

/** Fields worth asking for. The API returns only what is requested. */
const FIELDS = [
  'vin', 'stock', 'type', 'year', 'make', 'model', 'trim', 'date_in_stock',
  'mileage', 'vdp_url', 'source_id', 'pricing', 'dealer', 'media', 'mechanical',
  'body_details', 'history_report', 'status',
];

interface CcListing {
  vin?: string;
  stock?: string;
  type?: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  date_in_stock?: string;
  mileage?: number;
  vdp_url?: string;
  source_id?: string;
  pricing?: { our_price?: number; price?: number; msrp?: number; internet_price?: number };
  dealer?: { location?: string; name?: string | null; api_id?: string };
  media?: { images?: string[] };
  mechanical?: {
    engine?: string; drivetrain?: string; fuel_type?: string; transmission?: string;
    city_mpg?: number; highway_mpg?: number; horsepower?: number; engine_size?: string;
  };
  body_details?: { body_type?: string; exterior_color?: string; interior_color?: string; doors?: number };
  history_report?: { carfax_oneowner?: boolean | null; carfax_url?: string | null };
}

interface Credentials { account: string; apiKey: string }

const CREDENTIALS = new Map<string, Credentials | null>();

/**
 * The API key, which is not account-scoped.
 *
 * A key learned from one storefront reads another account's inventory: Ken
 * Garff's key returns BMW of Camarillo's 71 used cars under a different account
 * id. That changes what a new rooftop costs. It is not a browser visit and a
 * discovery dance, it is an account id, so a spec may name one directly and
 * skip the page load entirely.
 *
 * Cached across hosts for that reason, and still relearned from any storefront
 * that happens to be visited, so a rotation is picked up without a code change.
 */
let sharedApiKey: string | null = null;

/**
 * Learns a storefront's account id and API key by watching it load.
 *
 * Both are baked into a bundle, so there is nothing to read out of the HTML.
 * The search call the page makes on its own carries both, which makes one page
 * visit the cheapest way to get them and the only one that survives the site
 * rotating its key.
 */
async function discover(host: string, log: (m: string) => void): Promise<Credentials | null> {
  const cached = CREDENTIALS.get(host);
  if (cached !== undefined) return cached;

  let found: Credentials | null = null;
  for (const path of INVENTORY_PATHS) {
    try {
      const responses = await captureJson(`${host}${path}`, { waitMs: 9000 });
      for (const r of responses) {
        if (!r.url.includes(SEARCH_HOST)) continue;
        const account = r.url.match(/\/listings\/(\d+)\/search/)?.[1];
        const apiKey = r.requestHeaders?.['x-api-key'];
        if (account && apiKey) {
          sharedApiKey = apiKey;
          found = { account, apiKey };
          break;
        }
        // An account with no key still counts if a sibling storefront has
        // already taught us one, because the key is not account-scoped.
        if (account && sharedApiKey) { found = { account, apiKey: sharedApiKey }; break; }
      }
    } catch {
      /* a path this storefront does not have; try the next */
    }
    if (found) break;
  }

  CREDENTIALS.set(host, found);
  if (found) log(`carscommerce ${host}: account ${found.account}`);
  else log(`carscommerce ${host}: the page never called the listings API, so it is not a Dealer Inspire storefront`);
  return found;
}

/** "411 E DAILY DR<br/>Camarillo, CA 93010<br/>(805) 482-8878" -> "Camarillo, CA 93010". */
export function parseLocation(raw: string | undefined): string | null {
  if (!raw) return null;
  const parts = raw.split(/<br\s*\/?>/i).map((p) => p.trim()).filter(Boolean);
  // The middle line is the city, state and postcode; the first is the street
  // and the last is a phone number.
  const city = parts.find((p) => /,\s*[A-Z]{2}\b/.test(p));
  return city ?? parts[0] ?? null;
}

/**
 * The advertised price.
 *
 * `our_price` is the number the storefront shows. `price` repeats it on most
 * records and `msrp` is the sticker on a new car, which is not what a used one
 * sells for, so it is never used as the asking price.
 */
export function advertisedPrice(p: CcListing['pricing']): number | null {
  for (const value of [p?.our_price, p?.internet_price, p?.price]) {
    if (typeof value === 'number' && value > 0) return value;
  }
  return null;
}

export interface CarsCommerceSpec {
  /** Registry id. */
  id: string;
  /** Storefront origin, e.g. https://www.kengarff.com */
  host: string;
  /**
   * The Cars Commerce account id, when it is already known.
   *
   * Supplying it skips the browser visit entirely, which is the whole payoff of
   * the key being global: a rooftop becomes one line of config rather than a
   * page load and a capture.
   */
  account?: string;
}

export function carsCommerce(spec: CarsCommerceSpec): SourceAdapter {
  return {
    source: getSource(spec.id)!,

    async search(query: SearchQuery, ctx): Promise<Listing[]> {
      const credentials = spec.account && sharedApiKey
        ? { account: spec.account, apiKey: sharedApiKey }
        : await discover(spec.host, ctx.log);
      if (!credentials) return [];
      // A spec that named an account still needs a key, and the first storefront
      // crawled provides it for every other one in the run.
      if (spec.account && credentials.account !== spec.account) {
        credentials.account = spec.account;
      }

      const now = new Date().toISOString();
      const out = new Map<string, ListingDraft>();
      const facetFilters: Record<string, string[]> = {
        // Used only. A new-car price is not a comparable for a used one.
        type_slug: ['Pre-Owned', 'Certified Pre-Owned'],
      };
      if (query.make) facetFilters.make = [query.make];
      if (query.models?.length) facetFilters.model = query.models;

      let total: number | null = null;

      for (let page = 1; page <= 40; page += 1) {
        try {
          const res = await fetch(`https://${SEARCH_HOST}/api/v1/listings/${credentials.account}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': credentials.apiKey },
            body: JSON.stringify({
              page,
              perPage: 100,
              filters: { status: ['publish', 'modified', 'pend-sale'] },
              facetFilters,
              requestedFields: FIELDS,
            }),
            signal: AbortSignal.timeout(45_000),
          });
          if (!res.ok) {
            ctx.log(`${spec.id} p${page} HTTP ${res.status}`);
            break;
          }

          const body = (await res.json()) as {
            data?: { listings?: CcListing[] };
            meta?: { pagination?: { total?: number; total_pages?: number } };
          };
          const listings = body.data?.listings ?? [];
          if (listings.length === 0) break;
          total ??= body.meta?.pagination?.total ?? null;
          let kept = 0;

          for (const l of listings) {
            const price = advertisedPrice(l.pricing);
            if (!l.vin || price === null) continue;
            const id = `${spec.id}:${l.vin.toUpperCase()}`;
            if (out.has(id)) continue;

            const m = l.mechanical ?? {};
            const b = l.body_details ?? {};
            const miles = typeof l.mileage === 'number' && l.mileage >= 0 ? l.mileage : null;

            out.set(id, {
              id,
              sourceId: spec.id,
              sourceListingId: l.stock ?? l.vin,
              url: l.vdp_url ?? spec.host,
              title: [l.year, l.make, l.model, l.trim].filter(Boolean).join(' '),
              year: typeof l.year === 'number' ? l.year : null,
              make: l.make ?? null,
              model: l.model ?? null,
              trim: l.trim ?? null,
              series: null,
              vin: isValidVin(l.vin) ? l.vin.toUpperCase() : null,
              price,
              priceKind: 'ask',
              currency: 'USD',
              mileage: miles,
              mileageIsRounded: isRoundedMileage(miles),
              location: parseLocation(l.dealer?.location),
              sellerType: 'dealer',
              dealerName: l.dealer?.name ?? null,
              certified: l.type === 'Certified Pre-Owned',
              /**
               * Carfax's one-owner badge, which the storefront licenses and
               * shows. It is null on most records and true only where the badge
               * is actually displayed, so it is read as a fact and never
               * inferred from its absence.
               */
              owners: l.history_report?.carfax_oneowner === true ? 1 : null,
              bodyType: canonicalBodyType(b.body_type),
              exteriorColor: canonicalColor(b.exterior_color),
              interiorColor: canonicalColor(b.interior_color),
              doors: typeof b.doors === 'number' ? b.doors : null,
              engine: m.engine ?? null,
              fuelType: canonicalFuelType(m.fuel_type),
              transmission: parseTransmission(m.transmission),
              drivetrain: parseDrivetrain(m.drivetrain),
              // Zero is this feed's way of saying it has no figure, not a car
              // that does nothing to the gallon.
              mpgCity: m.city_mpg ? m.city_mpg : null,
              mpgHighway: m.highway_mpg ? m.highway_mpg : null,
              eventDate: null,
              imageUrl: l.media?.images?.[0] ?? null,
              firstSeen: now,
              lastSeen: now,
              raw: {
                sourceId: l.source_id,
                dateInStock: l.date_in_stock,
                horsepower: m.horsepower,
                carfaxUrl: l.history_report?.carfax_url ?? undefined,
              },
            });
            kept += 1;
          }

          ctx.log(`${spec.id} p${page} ${String(listings.length).padStart(3)} listings, ${kept} kept (pool ${out.size}${total ? ` of ${total}` : ''})`);
          if (listings.length < 100) break;
          const pages = body.meta?.pagination?.total_pages;
          if (pages !== undefined && page >= pages) break;
        } catch (e) {
          ctx.log(`${spec.id} p${page} FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }
      }

      return [...out.values()].map(makeListing);
    },
  };
}

/**
 * Two large groups on the platform, and the shape every other one takes.
 *
 * Ken Garff is a top-ten US dealer group and reports 5,711 used cars through
 * this API. Koons runs the same platform across Virginia and Maryland. Adding
 * the next group is one line here plus a registry row.
 */
export const kengarff = carsCommerce({ id: 'kengarff', host: 'https://www.kengarff.com' });

/**
 * A second account reached with the first one's key and no page load at all,
 * which is the proof that the platform rather than the site is what was wired.
 */
export const bmwcamarillo = carsCommerce({
  id: 'bmwcamarillo',
  host: 'https://www.bmwofcamarillo.com',
  account: '6063909',
});
