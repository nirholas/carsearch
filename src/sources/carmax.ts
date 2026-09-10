import type { Listing, SearchQuery, SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { evaluateInPage } from '../transport/browser.js';
import { isRoundedMileage, isValidVin } from '../core/normalize.js';

/**
 * CarMax: the best free structured data of any source tested.
 *
 * It ships clean JSON-LD, one `@type: Car` block per vehicle, INCLUDING the
 * VIN. That makes it the only source in the registry that dedupes exactly
 * rather than by composite key, and it is the anchor every other source's
 * fuzzy matching is measured against.
 */

export interface LdCar {
  '@type': string;
  name?: string;
  brand?: { name?: string };
  model?: string;
  vehicleConfiguration?: string;
  vehicleModelDate?: string | number;
  vehicleIdentificationNumber?: string;
  mileageFromOdometer?: { value?: string | number };
  offers?: { price?: string | number };
  color?: string;
  bodyType?: string;
  fuelType?: string;
  image?: string | string[];
}

const EXTRACT = (): LdCar[] =>
  [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map((s) => {
      try {
        return JSON.parse(s.textContent ?? 'null');
      } catch {
        return null;
      }
    })
    .flatMap((x) => (Array.isArray(x) ? x : [x]))
    .filter((x): x is LdCar => Boolean(x) && x['@type'] === 'Car');

/**
 * Whether a JSON-LD record is the model that was asked for.
 *
 * Compared on alphanumerics only, so `Macan S` matches a query for `macan`
 * while `i3` never matches `i8`. The record's own `model` is authoritative;
 * when it is absent the name is used, because a record with no model at all
 * must not be assumed to be the one requested.
 */
export function isModel(car: LdCar, wanted: string): boolean {
  const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = key(wanted);
  const field = car.model ? key(car.model) : null;
  if (field) return field === want || field.startsWith(want);
  const name = key(car.name ?? '');
  return name.includes(want);
}

function slug(make: string, model: string): string {
  return `${make}/${model}`.toLowerCase().replace(/\s+/g, '-');
}

export const carmax: SourceAdapter = {
  source: getSource('carmax')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    const make = query.make;
    if (!make) {
      ctx.log('carmax: needs a make, skipping');
      return [];
    }
    const models = query.models?.length ? query.models : [''];

    for (const model of models) {
      const path = model ? slug(make, model) : make.toLowerCase();
      const url = `https://www.carmax.com/cars/${path}`;
      try {
        const cars = await evaluateInPage(url, EXTRACT, { waitMs: 5000, scroll: true });

        /**
         * Filter on brand AND on the model that was asked for.
         *
         * Brand alone is not enough. A model slug CarMax has no stock for
         * still answers 200, with the make's general inventory: a live search
         * for `bmw/i8` returned 44 cars, every one of them an X3, X5, Z4 or
         * 330i, and each was plausible enough to survive every downstream
         * check because each really is a BMW. The similar-vehicles blocks that
         * put a 2018 Mercedes-Benz SLC300 into a Porsche dataset are the same
         * failure one step further out.
         */
        const mine = cars.filter((c) => {
          if ((c.brand?.name ?? '').toLowerCase() !== make.toLowerCase()) return false;
          return model ? isModel(c, model) : true;
        });

        for (const c of mine) {
          const vin = c.vehicleIdentificationNumber ?? null;
          const price = c.offers?.price !== undefined ? Number(c.offers.price) : null;
          const miles = c.mileageFromOdometer?.value !== undefined ? Number(c.mileageFromOdometer.value) : null;
          const id = `carmax:${vin ?? `${c.name}-${price}-${miles}`}`;
          if (out.has(id)) continue;

          out.set(id, {
            id,
            sourceId: 'carmax',
            sourceListingId: vin,
            // CarMax exposes no stable per-car URL in the listing markup, so
            // link by VIN search instead of fabricating one.
            url: isValidVin(vin) ? `https://www.carmax.com/cars?search=${vin}` : url,
            title: c.name ?? '',
            year: c.vehicleModelDate !== undefined ? Number(c.vehicleModelDate) : null,
            make: c.brand?.name ?? make,
            model: c.model ?? (model || null),
            trim: c.vehicleConfiguration ?? null,
            series: null,
            vin: isValidVin(vin) ? vin.toUpperCase() : null,
            price: Number.isFinite(price) ? price : null,
            priceKind: 'ask',
            currency: 'USD',
            mileage: Number.isFinite(miles) ? miles : null,
            mileageIsRounded: isRoundedMileage(miles),
            location: 'nationwide (CarMax ships)',
            sellerType: 'dealer',
            bodyType: c.bodyType ?? null,
            exteriorColor: c.color ?? null,
            fuelType: c.fuelType ?? null,
            eventDate: null,
            imageUrl: Array.isArray(c.image) ? (c.image[0] ?? null) : (c.image ?? null),
            firstSeen: now,
            lastSeen: now,
          });
        }
        ctx.log(`carmax ${path.padEnd(22)} +${String(mine.length).padStart(3)} of ${cars.length} ld+json blocks (pool ${out.size})`);
      } catch (e) {
        ctx.log(`carmax ${path} FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    return [...out.values()].map(makeListing);
  },
};
