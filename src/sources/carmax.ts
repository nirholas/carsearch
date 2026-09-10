import type { SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { isRoundedMileage, isValidVin } from '../core/normalize.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';

/**
 * CarMax, read through its own search API rather than its HTML.
 *
 * This adapter used to load one rendered page and scrape its JSON-LD. That
 * markup carries only the cars on the first page, and CarMax paginates, so a
 * nationwide Macan search returned 44 of the 155 cars they actually had. The
 * 111 it missed were disproportionately the CHEAP ones, because the default
 * sort buries older high-mileage inventory: the adapter reported a floor of
 * $33,998 for a Macan S when the real floor was $25,998. A source that is
 * silently 72% short looks exactly like a source with thin inventory.
 *
 * The API behind the same page returns everything, a hundred cars per request,
 * and carries more per car than the JSON-LD did: VIN, stock number, trim,
 * series, drivetrain, colours, prior use and a real per-vehicle URL.
 *
 * THE PARAMETER FORM MATTERS, and the wrong one fails silently.
 *
 *   ?uri=/cars/porsche/macan     totalCount 155, all of them Porsche Macans
 *   ?make=Porsche&model=Macan    totalCount 58805, first result a Ford Mustang
 *
 * The second answers 200 with a full page of items and simply ignores the
 * filter, which is the same failure as a rotted make slug and as Autotrader's
 * 200-with-a-captcha. Never move this to the make/model form.
 */

const API = 'https://www.carmax.com/cars/api/search/run';

/** Cars per request. The endpoint caps silently above this. */
const TAKE = 100;

/**
 * Stop after this many pages of one query.
 *
 * A guard against a filter that stops being honoured upstream and turns a model
 * search into a walk of all 58,000 cars, not a limit we expect to reach: the
 * largest legitimate model catalogue here runs to a few hundred.
 */
const MAX_PAGES = 30;

export interface CarmaxItem {
  stockNumber?: string | number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  trim?: string | null;
  series?: string | null;
  basePrice?: number;
  mileage?: number;
  storeCity?: string;
  stateAbbreviation?: string;
  exteriorColor?: string;
  interiorColor?: string;
  fuelType?: string;
  transmission?: string;
  driveTrain?: string;
  cylinders?: number | string;
  mpgCity?: number;
  mpgHighway?: number;
  body?: string;
  heroImageUrl?: string;
  priorUseDescriptions?: string[];
}

interface CarmaxPage {
  items?: CarmaxItem[];
  totalCount?: number;
}

const slug = (s: string) => s.toLowerCase().trim().replace(/\s+/g, '-');

/**
 * Whether a returned car is the one that was asked for.
 *
 * Kept from the previous implementation because the reason has not changed: a
 * model slug CarMax has no stock for still answers 200 with the make's general
 * inventory, and every one of those cars is plausible enough to survive the
 * downstream checks. Compared on alphanumerics, so "Macan S" matches a query
 * for "macan" while "i3" never matches "i8".
 */
export function isWanted(item: CarmaxItem, make: string, model: string | null): boolean {
  const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key(item.make ?? '') !== key(make)) return false;
  if (!model) return true;
  const field = key(item.model ?? '');
  const want = key(model);
  return field === want || field.startsWith(want);
}

/** CarMax states prior use. "Fleet" is real history; it is NOT a title brand. */
export function normalizeUse(descriptions?: string[]): 'fleet' | 'rental' | 'personal' | null {
  if (!descriptions?.length) return null;
  const blob = descriptions.join(' ').toLowerCase();
  if (blob.includes('rental')) return 'rental';
  if (blob.includes('fleet') || blob.includes('lease')) return 'fleet';
  return 'personal';
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
    const models = query.models?.length ? query.models : [null];

    for (const model of models) {
      const uri = model ? `/cars/${slug(make)}/${slug(model)}` : `/cars/${slug(make)}`;
      let total: number | null = null;
      let kept = 0;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const skip = page * TAKE;
        if (total !== null && skip >= total) break;

        const url = `${API}?uri=${encodeURIComponent(uri)}&skip=${skip}&take=${TAKE}`;
        let body: CarmaxPage;
        try {
          const res = await fetchWithTls(url, { headers: { accept: 'application/json' } });
          if (res.status !== 200) {
            ctx.log(`carmax ${uri} p${page}: HTTP ${res.status}`);
            break;
          }
          body = JSON.parse(res.body) as CarmaxPage;
        } catch (e) {
          ctx.log(`carmax ${uri} p${page} FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }

        if (total === null) total = body.totalCount ?? null;
        const items = body.items ?? [];
        if (!items.length) break;

        const mine = items.filter((i) => isWanted(i, make, model));
        for (const i of mine) {
          const vin = i.vin ?? null;
          const stock = i.stockNumber != null ? String(i.stockNumber) : null;
          const id = `carmax:${vin ?? stock ?? `${i.year}-${i.model}-${i.basePrice}`}`;
          if (out.has(id)) continue;

          const price = Number(i.basePrice);
          const miles = Number(i.mileage);
          const place = [i.storeCity, i.stateAbbreviation].filter(Boolean).join(', ');

          out.set(id, {
            id,
            sourceId: 'carmax',
            sourceListingId: stock ?? vin,
            // A real per-car page, which the JSON-LD never exposed. The old
            // adapter linked to a VIN search because it had nothing better.
            url: stock ? `https://www.carmax.com/car/${stock}` : `https://www.carmax.com/cars?search=${vin ?? ''}`,
            title: [i.year, i.make, i.model, i.trim].filter(Boolean).join(' '),
            year: Number.isFinite(i.year) ? Number(i.year) : null,
            make: i.make ?? make,
            model: i.model ?? model,
            trim: i.trim || null,
            series: i.series || null,
            vin: isValidVin(vin) ? vin!.toUpperCase() : null,
            price: Number.isFinite(price) ? price : null,
            priceKind: 'ask',
            currency: 'USD',
            mileage: Number.isFinite(miles) ? miles : null,
            mileageIsRounded: isRoundedMileage(Number.isFinite(miles) ? miles : null),
            // Any CarMax car transfers to any store, so the city is where it
            // sits rather than where a buyer has to go.
            location: place ? `${place} (CarMax ships)` : 'nationwide (CarMax ships)',
            sellerType: 'dealer',
            bodyType: i.body ?? null,
            exteriorColor: i.exteriorColor ?? null,
            interiorColor: i.interiorColor ?? null,
            fuelType: i.fuelType ?? null,
            transmission: parseTransmission(i.transmission),
            drivetrain: parseDrivetrain(i.driveTrain),
            mpgCity: Number.isFinite(Number(i.mpgCity)) ? Number(i.mpgCity) : null,
            mpgHighway: Number.isFinite(Number(i.mpgHighway)) ? Number(i.mpgHighway) : null,
            cylinders: Number.isFinite(Number(i.cylinders)) ? Number(i.cylinders) : null,
            usage: normalizeUse(i.priorUseDescriptions),
            eventDate: null,
            imageUrl: i.heroImageUrl ?? null,
            firstSeen: now,
            lastSeen: now,
          });
          kept += 1;
        }

        ctx.log(
          `carmax ${uri.padEnd(26)} p${page} +${String(mine.length).padStart(3)} of ${items.length} ` +
          `(pool ${out.size} of ${total ?? '?'})`,
        );
        if (items.length < TAKE) break;
      }

      // Answered, and nothing matched: the slug is wrong or the model is out of
      // stock. Say which, rather than reporting an indistinguishable silence.
      if (total !== null && kept === 0) {
        ctx.log(`carmax ${uri}: ${total} cars returned, none on-model`);
      }
    }

    return [...out.values()].map(makeListing);
  },
};
