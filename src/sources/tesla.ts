import type { Listing, SearchQuery, SourceAdapter } from '../core/types.js';
import { getSource } from './registry.js';
import { evaluateInPage } from '../transport/browser.js';
import { isRoundedMileage, isValidVin } from '../core/normalize.js';

/**
 * Tesla's own used inventory, straight off the JSON endpoint its website calls.
 *
 * Structured, VIN-bearing and free. Note that the endpoint refuses a bare
 * request from a datacenter IP (403), so it is fetched through the browser
 * transport, which carries the TLS fingerprint and headers it expects. That is
 * the two-transport design earning its keep in the other direction from
 * Cars.com.
 */

const MODEL_CODES: Record<string, string> = {
  'model 3': 'm3',
  'model y': 'my',
  'model s': 'ms',
  'model x': 'mx',
  cybertruck: 'ct',
  m3: 'm3',
  my: 'my',
  ms: 'ms',
  mx: 'mx',
};

interface TeslaCar {
  VIN?: string;
  Year?: number;
  Model?: string;
  TrimName?: string;
  Odometer?: number;
  InventoryPrice?: number;
  Price?: number;
  City?: string;
  StateProvince?: string;
  PAINT?: string[];
  MainPhoto?: string[][] | string[];
}

function buildUrl(modelCode: string, zip: string): string {
  const query = {
    query: {
      model: modelCode,
      condition: 'used',
      options: {},
      arrangeby: 'Price',
      order: 'asc',
      market: 'US',
      language: 'en',
      super_region: 'north america',
      zip,
      range: 0,
    },
    offset: 0,
    count: 50,
    outsideOffset: 0,
    outsideSearch: true,
  };
  return `https://www.tesla.com/inventory/api/v4/inventory-results?query=${encodeURIComponent(JSON.stringify(query))}`;
}

export const tesla: SourceAdapter = {
  source: getSource('tesla')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out: Listing[] = [];

    const wanted = query.models?.length
      ? query.models.map((m) => MODEL_CODES[m.toLowerCase()]).filter((x): x is string => Boolean(x))
      : ['m3', 'my', 'ms', 'mx'];
    if (wanted.length === 0) return [];

    for (const code of wanted) {
      const url = buildUrl(code, query.zip ?? '90001');
      try {
        const text = await evaluateInPage(url, () => document.body.innerText, { waitMs: 1500, scroll: false });
        const data = JSON.parse(text) as { results?: TeslaCar[] | { exact?: TeslaCar[] } };
        const rows = Array.isArray(data.results) ? data.results : (data.results?.exact ?? []);

        for (const c of rows) {
          const vin = c.VIN ?? null;
          const price = c.InventoryPrice ?? c.Price ?? null;
          const id = `tesla:${vin ?? `${c.Model}-${c.Year}-${price}`}`;
          const photo = Array.isArray(c.MainPhoto?.[0]) ? c.MainPhoto[0][0] : (c.MainPhoto?.[0] as string | undefined);
          out.push({
            id,
            sourceId: 'tesla',
            sourceListingId: vin,
            url: vin ? `https://www.tesla.com/${code}/order/${vin}` : null,
            title: `${c.Year ?? ''} Tesla ${c.Model ?? code} ${c.TrimName ?? ''}`.trim(),
            year: c.Year ?? null,
            make: 'Tesla',
            model: c.Model ?? code,
            trim: c.TrimName ?? null,
            series: null,
            vin: isValidVin(vin) ? vin.toUpperCase() : null,
            price,
            priceKind: 'ask',
            currency: 'USD',
            mileage: c.Odometer ?? null,
            mileageIsRounded: isRoundedMileage(c.Odometer ?? null),
            location: [c.City, c.StateProvince].filter(Boolean).join(', ') || null,
            sellerType: 'dealer',
            bodyType: null,
            exteriorColor: c.PAINT?.[0] ?? null,
            fuelType: 'Electric',
            eventDate: null,
            imageUrl: photo ?? null,
            firstSeen: now,
            lastSeen: now,
          });
        }
        ctx.log(`tesla ${code.padEnd(6)} +${String(rows.length).padStart(3)} (pool ${out.length})`);
      } catch (e) {
        ctx.log(`tesla ${code} FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    return out;
  },
};
