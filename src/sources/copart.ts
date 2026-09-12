import type { SourceAdapter, SearchQuery, PriceKind } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { parseTitleStatus, type TitleStatus } from '../core/facets.js';
import { canonicalBodyType } from '../core/canonical.js';

/**
 * Copart: the largest salvage auction in the world.
 *
 * A whole category the index did not cover, and the only source found so far
 * that states a title brand on EVERY lot. Title status, the facet a buyer most
 * wants and dealer sites never publish, sits near zero coverage everywhere
 * else; here it is a required field.
 *
 * The registry recorded this as blocked. It is not, and the reason it looked
 * blocked is instructive: the search service answers a POST and returns 405 to
 * anything else, while the TLS transport was quietly sending every request as a
 * GET because its request options were being handed to the client constructor.
 * A wrong verb reads exactly like a wrong path.
 *
 * Their field names are two and three letters. The mapping below is the useful
 * part of this adapter; it was read off a live record rather than guessed.
 */

interface CopartLot {
  /** Lot number. */
  ln?: number;
  lotNumberStr?: string;
  /** Make name, uppercased. */
  mkn?: string;
  /** Model, and the model group it belongs to. */
  lm?: string;
  lmg?: string;
  /** Trim detail. */
  ltd?: string;
  /** Model year. */
  lcy?: number;
  /** VIN, partially masked. */
  fv?: string;
  /** Odometer reading, and whether it is believed accurate. */
  orr?: number;
  ord?: string;
  /** Engine description and cylinder count. */
  egn?: string;
  cy?: number;
  /** Lot description, which reads as the title. */
  ld?: string;
  /** Yard name, e.g. "FL - MIAMI SOUTH". */
  yn?: string;
  cuc?: string;
  /** Auction date, epoch milliseconds. */
  ad?: number;
  /** Current high bid, and the buy-it-now price when offered. */
  hb?: number;
  bnp?: number;
  bndc?: string;
  /** Title group description: "CLEAN TITLE", "SALVAGE", and so on. */
  tgd?: string;
  /** Damage description, e.g. "MINOR DENT/SCRATCHES". */
  dd?: string;
  /** Insurer's estimate of the car's undamaged value. */
  lotPlugAcv?: number;
  memberVehicleType?: string;
  tims?: string;
  /** Sale status; a sold lot carries its price here. */
  dynamicLotDetails?: { lotSold?: boolean; currentBid?: number };
}

interface CopartResponse {
  data?: { results?: { content?: CopartLot[]; totalElements?: number } };
}

const ENDPOINT = 'https://www.copart.com/public/lots/search-results';

/**
 * Copart's own title vocabulary, which is more specific than free text.
 *
 * Mapped explicitly rather than through the text parser, because these are
 * controlled values and a buyer acts on them. Anything unrecognized falls
 * through to the text parser and then to null, never to "clean".
 */
const TITLE_GROUPS: [RegExp, TitleStatus][] = [
  [/\bcertificate of destruction|non[\s-]?repairable|junk\b/i, 'junk'],
  [/\bparts? only\b/i, 'parts-only'],
  [/\bflood\b/i, 'flood'],
  [/\brebuilt|reconstructed\b/i, 'rebuilt'],
  [/\bsalvage\b/i, 'salvage'],
  [/\blemon|manufacturer buy\s?back\b/i, 'lemon'],
  [/\bclean\b/i, 'clean'],
];

function titleStatusOf(lot: CopartLot): TitleStatus | null {
  const raw = lot.tgd ?? '';
  for (const [pattern, status] of TITLE_GROUPS) if (pattern.test(raw)) return status;
  return parseTitleStatus(raw);
}

/**
 * A live lot has a bid; a lot offered at a fixed price has an ask. Neither is a
 * completed sale, and Copart does not publish the hammer price to the public.
 */
function priceOf(lot: CopartLot): { price: number | null; kind: PriceKind } {
  if (lot.bnp && lot.bnp > 0 && /buy it now/i.test(lot.bndc ?? '')) return { price: lot.bnp, kind: 'ask' };
  if (lot.hb && lot.hb > 0) return { price: lot.hb, kind: 'bid' };
  return { price: null, kind: 'bid' };
}

function searchBody(term: string, page: number): string {
  return JSON.stringify({
    query: [term], filter: {}, sort: ['auction_date_type desc'],
    page, size: 100, start: page * 100,
    watchListOnly: false, freeFormSearch: true, hideImages: false,
    defaultSort: false, specificRowProvided: false,
    displayName: term, searchName: term, backUrl: '', includeTagByField: {}, rawParams: {},
  });
}

function termsFor(query: SearchQuery): string[] {
  if (query.models?.length) return query.models.map((m) => [query.make, m].filter(Boolean).join(' '));
  return [query.make ?? '*'];
}

/**
 * How deep to walk one search term, at 100 lots a page.
 *
 * This was the literal `[0, 1]`, so 200 lots, and Copart is the only source in
 * the index besides IAAI that publishes a title brand on every lot. Capping the
 * one source that answers the question this index exists to ask meant a
 * nationwide salvage search reported a ceiling it had invented.
 *
 * A ceiling, not an expectation: the loop below exits on an empty page, on a
 * short page, and on a page that adds no lot not already held.
 */
const MAX_PAGES = 40;

export const copart: SourceAdapter = {
  source: getSource('copart')!,

  async search(query, ctx) {
    const out = new Map<string, ListingDraft>();

    for (const term of termsFor(query)) {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        try {
          const res = await fetchWithTls(ENDPOINT, {
            method: 'POST',
            body: searchBody(term, page),
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          });
          if (res.status !== 200) {
            ctx.log(`copart "${term}" HTTP ${res.status}`);
            break;
          }

          const body = JSON.parse(res.body) as CopartResponse;
          const lots = body.data?.results?.content ?? [];
          if (lots.length === 0) break;

          let kept = 0;
          for (const lot of lots) {
            const lotNumber = lot.lotNumberStr ?? (lot.ln ? String(lot.ln) : null);
            if (!lotNumber) continue;
            const id = `copart:${lotNumber}`;
            if (out.has(id)) continue;

            const { price, kind } = priceOf(lot);
            if (price === null) continue;

            const model = lot.lm ?? lot.lmg ?? null;
            const title = lot.ld?.trim() || [lot.lcy, lot.mkn, model, lot.ltd].filter(Boolean).join(' ');

            out.set(id, {
              id,
              sourceId: 'copart',
              sourceListingId: lotNumber,
              url: `https://www.copart.com/lot/${lotNumber}`,
              title,
              year: lot.lcy && lot.lcy > 1900 ? lot.lcy : null,
              make: lot.mkn ?? null,
              model,
              trim: lot.ltd ?? null,
              /**
               * The VIN is masked to its last six characters, so it is not a
               * VIN. Storing the partial would break dedupe, which treats a VIN
               * match as exact: two different cars sharing a masked prefix
               * would be merged into one.
               */
              vin: null,
              price,
              priceKind: kind,
              currency: lot.cuc ?? 'USD',
              mileage: lot.orr && lot.orr > 0 ? lot.orr : null,
              /**
               * Copart states whether the reading is believed. "NOT ACTUAL"
               * means the odometer is not trusted, which is exactly what this
               * flag is for.
               */
              mileageIsRounded: !/actual/i.test(lot.ord ?? '') ,
              location: lot.yn ?? null,
              sellerType: 'auction',
              bodyType: canonicalBodyType(lot.memberVehicleType),
              engine: lot.egn ?? null,
              cylinders: lot.cy && lot.cy > 0 ? lot.cy : null,
              // The reason this source is worth having.
              titleStatus: titleStatusOf(lot),
              eventDate: lot.ad ? new Date(lot.ad).toISOString().slice(0, 10) : null,
              imageUrl: lot.tims ?? null,
              raw: {
                damage: lot.dd,
                titleGroup: lot.tgd,
                odometerBrand: lot.ord,
                // The insurer's estimate of the undamaged value. Useful context
                // beside a salvage bid, and never a price anyone paid.
                estimatedRetailValue: lot.lotPlugAcv,
              },
            });
            kept += 1;
          }
          ctx.log(`copart ${term.padEnd(20)} p${page} ${String(lots.length).padStart(3)} lots, ${kept} kept (pool ${out.size})`);
          // A pager that re-serves its last page rather than emptying would
          // otherwise spin to the ceiling adding nothing.
          if (kept === 0) break;
          if (lots.length < 100) break;
        } catch (e) {
          ctx.log(`copart "${term}" FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }
      }
    }

    return [...out.values()].map(makeListing);
  },
};
