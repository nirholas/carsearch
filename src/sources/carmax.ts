import type { Listing, SearchQuery, SourceAdapter } from '../core/types.js';
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

interface LdCar {
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

function slug(make: string, model: string): string {
  return `${make}/${model}`.toLowerCase().replace(/\s+/g, '-');
}

export const carmax: SourceAdapter = {
  source: getSource('carmax')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, Listing>();
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
         * Filter on brand. The page also embeds Car blocks for "similar
         * vehicles", which is how a 2018 Mercedes-Benz SLC300 got into a
         * Porsche dataset and sat there looking entirely plausible.
         */
        const mine = cars.filter((c) => (c.brand?.name ?? '').toLowerCase() === make.toLowerCase());

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

    return [...out.values()];
  },
};
