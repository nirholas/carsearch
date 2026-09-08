import type { SourceAdapter, SearchQuery } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { findRecords } from './nextjs.js';
import { isValidVin, isRoundedMileage } from '../core/normalize.js';
import { canonicalColor } from '../core/canonical.js';

/**
 * duPont Registry: exotic and collector dealer inventory.
 *
 * Reachable by plain request with a browser TLS fingerprint, and it is another
 * Next.js App Router site, so the inventory rides in the page's React Flight
 * payload rather than in an XHR. Each record carries a real VIN, which makes it
 * dedupe against the mainstream sources: the same 911 listed here and on
 * Cars.com collapses to one car with two badges.
 */

interface DuPontVehicle {
  id?: string;
  vin?: string;
  stock?: string;
  year?: number;
  price?: number;
  mileage?: number;
  certified?: boolean;
  brand?: { name?: string };
  model?: { name?: string };
  exteriorColor?: string;
  interiorColor?: string;
  condition?: { code?: string };
  dealer?: { name?: string };
  locations?: { city?: string; state?: string };
  mainImageUrl?: string;
}

function urlFor(query: SearchQuery, model?: string): string {
  const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
  const make = query.make ? slug(query.make) : 'all';
  return `https://www.dupontregistry.com/autos/results/${make}/${model ? slug(model) : 'all'}/all`;
}

export const dupontregistry: SourceAdapter = {
  source: getSource('dupontregistry')!,

  async search(query, ctx) {
    const out = new Map<string, ListingDraft>();
    const models = query.models?.length ? query.models : [undefined];

    for (const model of models) {
      const url = urlFor(query, model);
      try {
        const res = await fetchWithTls(url);
        if (res.status !== 200) {
          ctx.log(`dupontregistry ${model ?? 'all'} HTTP ${res.status}`);
          continue;
        }

        const records = findRecords<DuPontVehicle>(res.body, 'vin');
        let kept = 0;
        let priceOnRequest = 0;
        let offTopic = 0;

        for (const v of records) {
          if (!v.id) continue;
          const id = `dupontregistry:${v.id}`;
          if (out.has(id)) continue;

          /**
           * Zero means "price on request", which this segment uses constantly.
           * It is not a price and must never enter a median; a $0 car would
           * drag the exotic cohort's median to nothing.
           */
          if (!v.price || v.price <= 0) {
            priceOnRequest += 1;
            continue;
          }

          /**
           * Their results URL does not actually narrow the payload: asking for
           * a Porsche returns Ferraris and Bentleys too. Every row is correctly
           * labelled with its own make, so nothing is wrong, but the mismatch
           * is counted and logged rather than passed off as a filtered search.
           * The practical consequence is that this source is best crawled
           * broadly, without a make, since a make in the URL buys nothing.
           */
          const make = v.brand?.name ?? null;
          if (query.make && make && !make.toLowerCase().includes(query.make.toLowerCase())) offTopic += 1;

          const modelName = v.model?.name ?? null;
          const place = v.locations;

          out.set(id, {
            id,
            sourceId: 'dupontregistry',
            sourceListingId: v.stock ?? v.id,
            url: `https://www.dupontregistry.com/autos/listing/${v.id}`,
            title: [v.year, make, modelName].filter(Boolean).join(' '),
            year: v.year && v.year > 1900 ? v.year : null,
            make,
            model: modelName,
            vin: isValidVin(v.vin) ? v.vin!.toUpperCase() : null,
            price: v.price,
            priceKind: 'ask',
            currency: 'USD',
            // Zero miles here means undisclosed far more often than delivery mileage.
            mileage: v.mileage && v.mileage > 0 ? v.mileage : null,
            mileageIsRounded: isRoundedMileage(v.mileage ?? null),
            location: place?.city ? [place.city.trim(), place.state].filter(Boolean).join(', ') : null,
            sellerType: 'dealer',
            exteriorColor: canonicalColor(v.exteriorColor),
            interiorColor: canonicalColor(v.interiorColor),
            certified: v.certified ?? null,
            dealerName: v.dealer?.name ?? null,
            imageUrl: v.mainImageUrl ?? null,
            raw: {
              condition: v.condition?.code,
              exteriorColorName: v.exteriorColor,
              interiorColorName: v.interiorColor,
            },
          });
          kept += 1;
        }
        ctx.log(
          `dupontregistry ${(model ?? 'all').padEnd(14)} ${String(records.length).padStart(3)} records, ${kept} kept` +
          `${priceOnRequest ? `, ${priceOnRequest} price-on-request` : ''}` +
          `${offTopic ? `, ${offTopic} not ${query.make} (their URL does not filter)` : ''} (pool ${out.size})`,
        );
      } catch (e) {
        ctx.log(`dupontregistry ${model ?? 'all'} FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    return [...out.values()].map(makeListing);
  },
};
