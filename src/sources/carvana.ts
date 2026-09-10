import type { SourceAdapter, SearchQuery } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { findRecords } from './nextjs.js';
import { isValidVin, isRoundedMileage } from '../core/normalize.js';

/**
 * Carvana: national online retailer, fixed price, every car photographed.
 *
 * Reachable only through the TLS transport. A plain fetch gets 403 and so does
 * a real Chromium; a request carrying a Chrome TLS fingerprint returns the full
 * page. It was recorded in the registry as blocked on the strength of the first
 * two, which is exactly the kind of wrong conclusion the third transport exists
 * to correct.
 *
 * The inventory rides in the page's React Flight payload rather than in an XHR,
 * so the endpoint hunt came up empty and the data was in the HTML all along.
 * What it carries is unusually complete: a VIN on every car, plus trim, both
 * colours, body style, fuel type, fuel economy and seating, which are facets
 * most sources never publish.
 */

interface CarvanaPrice {
  total?: number;
  incentivizedPrice?: number;
  msrp?: number;
  kbbValue?: number;
  marketAdjustment?: number;
}

interface CarvanaVehicle {
  vehicleId?: number;
  stockNumber?: number | string;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  parentModel?: string;
  trim?: string;
  color?: string;
  interiorColor?: string;
  bodyStyle?: string;
  fuelType?: string;
  mileage?: number;
  milesPerGallon?: number | { city?: number; highway?: number };
  seatingCapacity?: number;
  price?: CarvanaPrice | number;
  imageUrl?: string;
  isPurchasePending?: boolean;
  /** The price before the most recent drop, with the date it changed. */
  previousPrice?: number;
  priceUpdateDate?: string;
  transportCost?: number;
  vdpSlug?: string;
}

/**
 * A ceiling, not an expectation. The loop below exits when a page stops adding
 * cars; this only bounds a pager that never stops answering.
 */
const MAX_PAGES = 40;

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function urlsFor(query: SearchQuery): { label: string; url: string }[] {
  const make = query.make ? slug(query.make) : null;
  if (!make) return [{ label: 'all', url: 'https://www.carvana.com/cars' }];
  if (!query.models?.length) return [{ label: make, url: `https://www.carvana.com/cars/${make}` }];
  return query.models.map((m) => ({
    label: `${make}/${slug(m)}`,
    url: `https://www.carvana.com/cars/${make}-${slug(m)}`,
  }));
}

/** Their price object carries the asking price alongside MSRP and a KBB figure. */
function askingPrice(p: CarvanaVehicle['price']): number | null {
  if (typeof p === 'number') return p > 0 ? p : null;
  if (!p) return null;
  // `total` is the advertised number. `msrp` is what it cost new and would be a
  // wildly wrong asking price; `kbbValue` is a third party's estimate.
  const n = p.total ?? p.incentivizedPrice;
  return typeof n === 'number' && n > 0 ? n : null;
}

function mpg(v: CarvanaVehicle['milesPerGallon']): { city: number | null; highway: number | null } {
  if (typeof v === 'number') return { city: null, highway: null };
  return { city: v?.city ?? null, highway: v?.highway ?? null };
}

/**
 * The one historical price Carvana publishes per car.
 *
 * `previousPrice` is only meaningful with `priceUpdateDate`: without the date
 * there is no point in time to attach it to, and a price with an invented
 * timestamp is worse than no history at all.
 */
export function dropHistory(v: CarvanaVehicle): { observedAt: string; price: number }[] | null {
  const price = Number(v.previousPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const when = v.priceUpdateDate ? new Date(v.priceUpdateDate) : null;
  if (!when || Number.isNaN(when.getTime())) return null;
  return [{ observedAt: when.toISOString(), price }];
}

export const carvana: SourceAdapter = {
  source: getSource('carvana')!,

  async search(query, ctx) {
    const out = new Map<string, ListingDraft>();

    for (const target of urlsFor(query)) {
      /**
       * Walk the pager until it stops yielding new cars.
       *
       * This used to stop at three pages, on a comment claiming the same cars
       * repeat after that. They do not. Measured against a live Macan search,
       * pages four, five and six each returned 23 vehicles that had not been
       * seen, so the cap was discarding everything past the first 67 of 265.
       * The stop condition is now the thing the cap was pretending to be: a
       * page that adds nothing new.
       */
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const before = out.size;
        const url = page === 1 ? target.url : `${target.url}?page=${page}`;
        try {
          const res = await fetchWithTls(url);
          if (res.status !== 200) {
            ctx.log(`carvana ${target.label} HTTP ${res.status}`);
            break;
          }

          const records = findRecords<CarvanaVehicle>(res.body, 'vehicleId');
          if (records.length === 0) {
            ctx.log(`carvana ${target.label} p${page}: no vehicles in the payload`);
            break;
          }

          let kept = 0;
          for (const v of records) {
            if (!v.vehicleId) continue;
            const id = `carvana:${v.vehicleId}`;
            if (out.has(id)) continue;

            const price = askingPrice(v.price);
            if (price === null) continue;

            const economy = mpg(v.milesPerGallon);
            const model = v.model ?? v.parentModel ?? null;

            out.set(id, {
              id,
              sourceId: 'carvana',
              sourceListingId: String(v.stockNumber ?? v.vehicleId),
              url: `https://www.carvana.com/vehicle/${v.vehicleId}`,
              title: [v.year, v.make, model, v.trim && v.trim !== 'base' ? v.trim : null].filter(Boolean).join(' '),
              year: v.year ?? null,
              make: v.make ?? null,
              model,
              trim: v.trim && v.trim !== 'base' ? v.trim : null,
              vin: isValidVin(v.vin) ? v.vin!.toUpperCase() : null,
              price,
              priceKind: 'ask',
              currency: 'USD',
              mileage: v.mileage ?? null,
              mileageIsRounded: isRoundedMileage(v.mileage ?? null),
              // Carvana ships nationally from a single inventory, so a city
              // would be the warehouse's, not a place a buyer travels to.
              location: 'nationwide (Carvana delivers)',
              sellerType: 'dealer',
              bodyType: v.bodyStyle ?? null,
              exteriorColor: v.color ?? null,
              interiorColor: v.interiorColor ?? null,
              fuelType: v.fuelType ?? null,
              seats: v.seatingCapacity ?? null,
              mpgCity: economy.city,
              mpgHighway: economy.highway,
              dealerName: 'Carvana',
              imageUrl: v.imageUrl ?? null,
              /**
               * Carvana states the price before its most recent drop and the
               * date it changed, so a car that has been marked down arrives
               * with one real historical point instead of starting flat. This
               * is the same seeded history KBB supplies, from a different
               * field, and it is testimony rather than our own observation.
               */
              priceHistory: dropHistory(v),
              raw: {
                msrp: typeof v.price === 'object' ? v.price?.msrp : undefined,
                // Their own comparison against a third-party valuation. Kept,
                // never used: this index rates against completed sales.
                kbbValue: typeof v.price === 'object' ? v.price?.kbbValue : undefined,
                purchasePending: v.isPurchasePending,
              },
            });
            kept += 1;
          }
          const added = out.size - before;
          ctx.log(
            `carvana ${target.label.padEnd(20)} p${page} ${String(records.length).padStart(3)} records, ` +
            `${kept} kept, ${added} new (pool ${out.size})`,
          );
          // The pager repeats its last page forever rather than 404ing, so the
          // only reliable end is a page that contributes nothing.
          if (added === 0) break;
        } catch (e) {
          ctx.log(`carvana ${target.label} FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }
      }
    }

    return [...out.values()].map(makeListing);
  },
};
