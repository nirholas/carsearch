import type { SourceAdapter, PriceKind } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { captureJson } from '../transport/browser.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';
import { isRoundedMileage } from '../core/normalize.js';

/**
 * Collecting Cars: enthusiast auctions across Britain, the US and Australia.
 *
 * Wired against the search API their own frontend calls rather than the
 * rendered page. That endpoint is the site's contract with its own client, so
 * it is both richer and far more stable than any selector: it returns the
 * current bid, the sold price and the buy-now price as separate fields, which
 * is exactly the distinction this index is built around, plus mileage, fuel and
 * transmission per lot.
 *
 * The endpoint carries a search key in its query string. It is published to
 * every visitor's browser and scoped to reading the public catalogue, but it
 * still rotates, so it is discovered at run time from the page rather than
 * hardcoded. One browser load per crawl buys an endpoint that keeps working.
 *
 * The collection is `production_listings` and every request must be filtered to
 * `sites:=cars`, which is what the 401 was about: a Typesense scoped key names
 * the collections it may read and rejects any other as unauthorized, so the
 * guess of `auctions` failed authentication rather than returning nothing. The
 * name was recovered by capturing the request body their frontend sends, not
 * just the response, because a search API is a POST and the query lives in the
 * body. It is the difference between seeing an endpoint and being able to call
 * one.
 *
 * It is worth the trouble because of what `listingStage:sold` reaches: 26,244
 * completed sales with the price, the currency and the exact moment of sale.
 * Completed sales are the scarcest input this index has, and the whole product
 * thesis is rating asking prices against them.
 */

interface CcFeatures {
  driveSide?: string;
  fuelType?: string;
  /** "52,818 Miles (Indicated)" or a km figure. */
  mileage?: string;
  modelYear?: string;
  transmission?: string;
}

interface CcDocument {
  auctionId?: number;
  id?: string;
  slug?: string;
  title?: string;
  vehicleMake?: string;
  productMake?: string;
  modelName?: string;
  productYear?: string | number;
  currentBid?: number;
  priceSold?: number;
  priceBuyNow?: number;
  currencyCode?: string;
  countryCode?: string;
  location?: string;
  listingStage?: string;
  stage?: string;
  noReserve?: boolean;
  reserveMet?: boolean;
  isSoldPriceHidden?: boolean;
  dtStageEndsUTC?: string;
  dtSoldUTC?: string;
  saleFormat?: string;
  mainImageUrl?: string;
  features?: CcFeatures;
  lotType?: string;
}

let endpoint: string | null = null;

/** Learns the search endpoint, key included, by watching the site load. */
async function discoverEndpoint(log: (m: string) => void): Promise<string | null> {
  if (endpoint) return endpoint;
  const responses = await captureJson('https://collectingcars.com/buy', { waitMs: 9000, scroll: true });
  const hit = responses.find((r) => r.url.includes('multi_search'));
  if (!hit) {
    log('collectingcars: the search endpoint was not called on page load; their frontend changed');
    return null;
  }
  endpoint = hit.url;
  log(`collectingcars: learned the search endpoint (${new URL(hit.url).host})`);
  return endpoint;
}

/** "52,818 Miles (Indicated)" and the kilometre form sites outside the US use. */
function parseMileage(raw: string | undefined): { miles: number | null; rounded: boolean } {
  if (!raw) return { miles: null, rounded: false };
  const n = Number(raw.replace(/[^\d]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return { miles: null, rounded: false };
  // Kilometres are converted, because a mixed-unit odometer column is worse
  // than a missing one: it silently ranks a 100,000 km car below a 70,000 mile one.
  const miles = /\bkm\b|kilomet/i.test(raw) ? Math.round(n * 0.621371) : n;
  return { miles, rounded: isRoundedMileage(miles) };
}

/**
 * One lot can carry three different numbers. Which one is real depends on the
 * stage, and recording the wrong one is the mistake this whole project exists
 * to avoid: a current bid is not a price anyone has paid.
 */
function priceOf(d: CcDocument): { price: number | null; kind: PriceKind } {
  const ended = /sold|ended|complete/i.test(`${d.listingStage ?? ''} ${d.stage ?? ''} ${d.saleFormat ?? ''}`);
  if (ended && d.priceSold && !d.isSoldPriceHidden) return { price: d.priceSold, kind: 'sold' };
  if (d.currentBid) return { price: d.currentBid, kind: 'bid' };
  if (d.priceBuyNow) return { price: d.priceBuyNow, kind: 'ask' };
  return { price: null, kind: 'bid' };
}

export const collectingcars: SourceAdapter = {
  source: getSource('collectingcars')!,

  async search(query, ctx) {
    const url = await discoverEndpoint(ctx.log);
    if (!url) return [];

    const out = new Map<string, ListingDraft>();
    const terms = query.models?.length
      ? query.models.map((m) => [query.make, m].filter(Boolean).join(' '))
      : [query.make ?? '*'];

    for (const term of terms) {
      // Typesense pages at 250; two pages is 500 lots per term, which is more
      // than the site holds for any single model.
      for (const page of [1, 2]) {
        try {
          /**
           * The key travels in the header as well as the query string.
           * Typesense accepts either, but this deployment answers a POST
           * carrying only the query-string form with a 401.
           */
          const key = new URL(url).searchParams.get('x-typesense-api-key') ?? '';
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-TYPESENSE-API-KEY': key },
            body: JSON.stringify({
              searches: [{
                collection: 'production_listings',
                q: term === '*' ? '*' : term,
                query_by: 'title,productMake,vehicleMake,productYear,modelId',
                /**
                 * `sites:=cars` is not optional. The same index serves their
                 * number-plate and memorabilia catalogues, and an unfiltered
                 * query returns "9 HL" registration plates alongside the cars.
                 */
                filter_by: 'sites:=cars',
                // Newest sale first, so a capped result set is the recent end
                // of the market rather than an arbitrary slice of it.
                sort_by: 'tsSoldUTC:desc',
                include_fields:
                  'id,auctionId,slug,title,location,countryCode,currencyCode,currentBid,priceBuyNow,' +
                  'priceSold,isSoldPriceHidden,listingStage,stage,saleFormat,lotType,noReserve,reserveMet,' +
                  'productYear,productMake,vehicleMake,modelName,features,mainImageUrl,dtSoldUTC,dtStageEndsUTC',
                per_page: 250,
                page,
              }],
            }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!res.ok) {
            ctx.log(`collectingcars "${term}" HTTP ${res.status}`);
            break;
          }

          const body = (await res.json()) as { results?: { hits?: { document?: CcDocument }[]; found?: number }[] };
          const hits = body.results?.[0]?.hits ?? [];
          if (hits.length === 0) break;

          let kept = 0;
          for (const hit of hits) {
            const d = hit.document;
            if (!d?.id || !d.title) continue;
            // The catalogue carries memorabilia and parts lots alongside cars.
            if (d.lotType && d.lotType !== 'car') continue;

            const id = `collectingcars:${d.id}`;
            if (out.has(id)) continue;

            const { price, kind } = priceOf(d);
            if (price === null) continue;

            const f = d.features ?? {};
            const { miles, rounded } = parseMileage(f.mileage);
            const year = Number(f.modelYear ?? d.productYear);

            out.set(id, {
              id,
              sourceId: 'collectingcars',
              sourceListingId: String(d.auctionId ?? d.id),
              url: d.slug ? `https://collectingcars.com/for-sale/${d.slug}` : null,
              title: d.title,
              year: Number.isFinite(year) && year > 1900 ? year : null,
              make: d.vehicleMake ?? d.productMake ?? null,
              model: d.modelName ?? null,
              price,
              priceKind: kind,
              /**
               * Kept in the lot's own currency. Converting would bake today's
               * exchange rate into a permanent record and make a British sale
               * incomparable with itself six months later.
               */
              currency: (d.currencyCode ?? 'usd').toUpperCase(),
              mileage: miles,
              mileageIsRounded: rounded,
              location: d.location ?? d.countryCode ?? null,
              sellerType: 'auction',
              fuelType: f.fuelType ?? null,
              transmission: parseTransmission(f.transmission),
              drivetrain: parseDrivetrain(f.driveSide),
              /**
               * The sold timestamp is the date of the sale; the stage end is
               * only when the listing stopped running. For a completed sale
               * they are usually the same day and where they differ the sale
               * is the one a price history is measured against.
               */
              eventDate: (d.dtSoldUTC ?? d.dtStageEndsUTC)?.slice(0, 10) ?? null,
              imageUrl: d.mainImageUrl ?? null,
              raw: {
                noReserve: d.noReserve,
                reserveMet: d.reserveMet,
                driveSide: f.driveSide,
                countryCode: d.countryCode,
                stage: d.listingStage ?? d.stage,
              },
            });
            kept += 1;
          }
          ctx.log(`collectingcars ${term.padEnd(20)} p${page} ${String(hits.length).padStart(3)} hits, ${kept} kept (pool ${out.size})`);
          if (hits.length < 250) break;
        } catch (e) {
          ctx.log(`collectingcars "${term}" FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }
      }
    }

    return [...out.values()].map(makeListing);
  },
};
