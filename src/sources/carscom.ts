import type { Listing, SearchQuery, SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { parseDrivetrain } from '../core/facets.js';
import { getSource } from './registry.js';
import { evaluateInPage } from '../transport/browser.js';
import { isRoundedMileage, isValidVin } from '../core/normalize.js';

/**
 * Cars.com.
 *
 * Do not parse the rendered card. Every result is a `<fuse-card>` custom
 * element carrying the complete record as JSON in a `data-vehicle-details`
 * attribute: VIN, price, mileage, year, make, model, trim, body style, fuel
 * type, drivetrain, dealer name and zip. Reading the attribute is both richer
 * than the visible markup and immune to the styling changes that break
 * selector-based extractors.
 *
 * Transport note: this source was reachable by plain fetch and blocked to a
 * browser on the morning of 2026-09-07, and had swapped to the opposite
 * arrangement by that evening. It is driven through the browser today because
 * that is what the prober last measured, not because of anything intrinsic.
 */

interface VehicleDetails {
  listingId?: string;
  vin?: string;
  year?: string;
  make?: string;
  model?: string;
  trim?: string;
  mileage?: string;
  price?: string;
  msrp?: string;
  bodyStyle?: string;
  fuelType?: string;
  drivetrain?: string;
  stockType?: string;
  primaryThumbnail?: string;
  seller?: { dealerName?: string; zip?: string };
  exteriorColor?: string | null;
  /** Cars.com's manufacturer-certified flag. */
  cpoIndicator?: boolean | null;
  shipPrice?: number | string | null;
}

const EXTRACT = (): VehicleDetails[] =>
  [...document.querySelectorAll('fuse-card[data-vehicle-details]')]
    .map((el) => {
      try {
        return JSON.parse(el.getAttribute('data-vehicle-details') ?? 'null') as VehicleDetails | null;
      } catch {
        return null;
      }
    })
    .filter((x): x is VehicleDetails => x !== null && Boolean(x.listingId));

function buildUrl(q: SearchQuery, model: string | undefined): string {
  const p = new URLSearchParams();
  p.set('stock_type', 'used');
  if (q.make) p.append('makes[]', q.make.toLowerCase());
  if (model) p.append('models[]', `${q.make?.toLowerCase()}-${model.toLowerCase()}`);
  if (q.priceMax) p.set('list_price_max', String(q.priceMax));
  if (q.priceMin) p.set('list_price_min', String(q.priceMin));
  if (q.yearMin) p.set('year_min', String(q.yearMin));
  if (q.yearMax) p.set('year_max', String(q.yearMax));
  if (q.mileageMax) p.set('mileage_max', String(q.mileageMax));
  p.set('maximum_distance', q.radius === undefined || q.radius === 'any' ? 'all' : String(q.radius));
  p.set('zip', q.zip ?? '90001');
  p.set('page_size', '100');
  p.set('sort', 'mileage');
  return `https://www.cars.com/shopping/results/?${p.toString()}`;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[,$]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export const carscom: SourceAdapter = {
  source: getSource('carscom')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    const models = query.models?.length ? query.models : [undefined];

    for (const model of models) {
      const url = buildUrl(query, model);
      try {
        const rows = await evaluateInPage(url, EXTRACT, {
          waitMs: 6000,
          settleSelector: 'fuse-card[data-vehicle-details]',
          stableChecks: 2,
          maxPolls: 8,
        });

        for (const v of rows) {
          const id = `carscom:${v.listingId}`;
          if (out.has(id)) continue;
          const price = num(v.price);
          const miles = num(v.mileage);
          // Pre-1981 cars carry a short chassis number here rather than a
          // 17-character VIN, so validate rather than trusting the field name.
          const vin = isValidVin(v.vin) ? v.vin.toUpperCase() : null;

          out.set(id, {
            id,
            sourceId: 'carscom',
            sourceListingId: v.listingId ?? null,
            url: `https://www.cars.com/vehicledetail/${v.listingId}/`,
            title: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' '),
            year: num(v.year),
            make: v.make ?? query.make ?? null,
            model: v.model ?? model ?? null,
            trim: v.trim ?? null,
            series: null,
            vin,
            price,
            priceKind: 'ask',
            currency: 'USD',
            mileage: miles,
            mileageIsRounded: isRoundedMileage(miles),
            location: v.seller?.zip ? `${v.seller.dealerName ?? 'dealer'} (${v.seller.zip})` : (v.seller?.dealerName ?? null),
            sellerType: 'dealer',
            bodyType: v.bodyStyle ?? null,
            exteriorColor: v.exteriorColor ?? null,
            fuelType: v.fuelType ?? null,
            eventDate: null,
            imageUrl: v.primaryThumbnail ?? null,

            /**
             * The card's own JSON already carries these. They were being
             * dropped into `raw` where nothing could filter on them, which made
             * the index ask a VIN decoder for a drivetrain the page had handed
             * us in plain text.
             */
            drivetrain: parseDrivetrain(v.drivetrain),
            certified: v.cpoIndicator ?? null,
            dealerName: v.seller?.dealerName ?? null,

            firstSeen: now,
            lastSeen: now,
            // `stockType` is Cars.com's new/used/certified flag and `msrp` is
            // the sticker, neither of which is an asking price. Kept, not used.
            raw: { stockType: v.stockType, msrp: v.msrp, shipPrice: v.shipPrice },
          });
        }
        ctx.log(`carscom ${(model ?? 'all').padEnd(14)} +${String(rows.length).padStart(3)} (pool ${out.size})`);
      } catch (e) {
        ctx.log(`carscom ${model ?? 'all'} FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    return [...out.values()].map(makeListing);
  },
};
