import type { SourceAdapter, PriceKind } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { parseYear, parseMake, parseModel, isNonVehicle } from '../core/normalize.js';

/**
 * RM Sotheby's: the top of the collector market, read over its own search API.
 *
 * Completed sales are the scarcest input this index holds, and this house
 * publishes them going back years with the hammer price and the currency it was
 * struck in. It reaches a part of the market no marketplace covers: the lots
 * here are the comparables that decide what a 1973 Carrera RS or a Carrera GT
 * is worth, and nothing on Cars.com will ever tell you that.
 *
 * There is no mileage and no VIN in the search payload, which is the honest
 * shape of this source rather than a gap to paper over. A price and a date from
 * a named auction house is still worth more to a valuation than a marketplace
 * asking price, because somebody actually paid it.
 */

const ENDPOINT = 'https://rmsothebys.com/api/search/SearchLots';

interface RmLot {
  id?: string;
  publicName?: string;
  /** A formatted amount with its currency, e.g. "€365,000 EUR". */
  value?: string;
  /** "Sold", "Not Sold", "Asking", "Offered Without Reserve", or empty. */
  valueType?: string;
  preSaleEstimate?: string;
  header?: string;
  link?: string;
  lot?: string;
  collection?: string;
  auctioned?: boolean;
}

/** Symbols the house formats prices with, mapped to ISO codes. */
const SYMBOLS: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP', '¥': 'JPY', 'CHF': 'CHF' };

/**
 * The amount and currency out of a formatted value.
 *
 * "Price Upon Request" and "Sale Agreed" are values too, and both mean no
 * number was published. Returning null for them keeps them out of the index
 * rather than storing a zero that ranks as the cheapest car in the world.
 */
export function parseValue(value: string | undefined): { amount: number; currency: string } | null {
  if (!value) return null;
  const digits = value.replace(/[^\d]/g, '');
  if (!digits) return null;
  const amount = Number(digits);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  // The trailing ISO code is the reliable half: "$1,445,000 USD" and
  // "AU$95,000 AUD" both open with a dollar sign and are not the same money.
  const iso = value.match(/\b([A-Z]{3})\b\s*$/)?.[1];
  if (iso) return { amount, currency: iso };
  const symbol = Object.keys(SYMBOLS).find((s) => value.includes(s));
  return { amount, currency: symbol ? SYMBOLS[symbol]! : 'USD' };
}

/**
 * What kind of price a lot's value is, or null when it is not a price at all.
 *
 * "Not Sold" is a lot that failed to meet reserve. Its value is the high bid,
 * and recording that as a sale would put a price in the comps column that
 * nobody was willing to pay, which is the single error this index exists to
 * avoid.
 */
export function priceKindOf(valueType: string | undefined): PriceKind | null {
  const t = (valueType ?? '').trim().toLowerCase();
  if (t === 'sold') return 'sold';
  if (t === 'asking') return 'ask';
  return null;
}

export const rmsothebys: SourceAdapter = {
  source: getSource('rmsothebys')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    if (!query.make) {
      ctx.log('rmsothebys: needs a make, skipping');
      return [];
    }

    let notSold = 0;
    let unpriced = 0;

    // Forty a page, twelve pages, so a marque with thousands of lots still
    // comes back in a bounded number of requests.
    for (let page = 0; page < 12; page += 1) {
      try {
        const res = await fetch(`${ENDPOINT}?page=${page}&pageSize=40`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            Make: query.make,
            Model: query.models?.[0] ?? null,
            FromYear: query.yearMin ?? null,
            ToYear: query.yearMax ?? null,
            SortBy: 'Availability',
            LocationCountry: [],
            CategoryTag: [],
          }),
          signal: AbortSignal.timeout(45_000),
        });
        if (!res.ok) {
          ctx.log(`rmsothebys HTTP ${res.status}`);
          break;
        }

        const body = (await res.json()) as { items?: RmLot[]; pager?: { totalPages?: number } };
        const items = body.items ?? [];
        if (items.length === 0) break;
        let kept = 0;

        for (const lot of items) {
          if (!lot.id || !lot.publicName || !lot.link) continue;
          if (isNonVehicle(lot.publicName)) continue;

          const kind = priceKindOf(lot.valueType);
          if (kind === null) {
            if ((lot.valueType ?? '').trim().toLowerCase() === 'not sold') notSold += 1;
            else unpriced += 1;
            continue;
          }
          const value = parseValue(lot.value);
          if (!value) { unpriced += 1; continue; }

          const id = `rmsothebys:${lot.id}`;
          if (out.has(id)) continue;

          const make = parseMake(lot.publicName) ?? query.make;
          out.set(id, {
            id,
            sourceId: 'rmsothebys',
            sourceListingId: lot.id,
            url: `https://rmsothebys.com${lot.link.startsWith('/') ? '' : '/'}${lot.link}`,
            title: lot.publicName,
            year: parseYear(lot.publicName),
            make,
            model: parseModel(lot.publicName, make),
            trim: null,
            series: null,
            vin: null,
            price: value.amount,
            priceKind: kind,
            /**
             * Kept in the currency it was struck in. Converting would bake
             * today's rate into a permanent record and make a European sale
             * incomparable with itself later.
             */
            currency: value.currency,
            mileage: null,
            mileageIsRounded: false,
            // The sale, which is how this house names its events.
            location: lot.header ?? null,
            sellerType: 'auction',
            eventDate: null,
            imageUrl: null,
            firstSeen: now,
            lastSeen: now,
            raw: {
              auction: lot.header,
              lotNumber: lot.lot || undefined,
              preSaleEstimate: lot.preSaleEstimate || undefined,
              tagline: lot.collection || undefined,
            },
          });
          kept += 1;
        }

        ctx.log(`rmsothebys ${query.make.padEnd(14)} p${page + 1} ${String(items.length).padStart(3)} lots, ${kept} kept (pool ${out.size})`);
        if (items.length < 40) break;
        if (body.pager?.totalPages !== undefined && page + 1 >= body.pager.totalPages) break;
      } catch (e) {
        ctx.log(`rmsothebys FAILED: ${(e as Error).message.split('\n')[0]}`);
        break;
      }
    }

    if (notSold) ctx.log(`rmsothebys: ${notSold} lots did not meet reserve, so their high bid is not a sale`);
    if (unpriced) ctx.log(`rmsothebys: ${unpriced} lots publish no number (price on request, sale agreed)`);
    return [...out.values()].map(makeListing);
  },
};
