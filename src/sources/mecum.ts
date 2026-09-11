import type { SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { isRoundedMileage, isValidVin, isNonVehicle, parseYear } from '../core/normalize.js';
import { parseTransmission } from '../core/facets.js';
import { canonicalColor } from '../core/canonical.js';

/**
 * Mecum: the largest collector-car auction house in the world, by lot count.
 *
 * Read over the WPGraphQL endpoint their own site queries, which was worth
 * finding rather than settling for. The rendered page carries no lot data at
 * all: an earlier sweep read the React payload, found no year, price or sold
 * key anywhere in it, and correctly recorded that the lots are client-fetched
 * and that nobody should write a parser for it. The client fetches from here.
 *
 * A Lot carries what this index is short of and what almost nothing else
 * publishes together: a hammer price, a VIN, an odometer reading with its unit,
 * the engine, the gearbox and the date the lot actually crossed the block.
 */

const ENDPOINT = 'https://mecum.stellate.sh/';

const LOTS_QUERY = `query CarsearchLots($first: Int!, $after: String, $search: String) {
  lots(first: $first, after: $after, where: { search: $search }) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      databaseId title uri lotNumber
      hammerPrice hideHammerPrice hideSaleResult highEstimate lowEstimate
      odometer odometerUnits isActualMiles vinSerial engine transmission color
      makes { nodes { name } } models { nodes { name } } lotYears { nodes { name } }
      runDates { nodes { name } }
      auction { nodes { title } }
      featuredImage { node { mediaItemUrl } }
    } }
  }
}`;

interface Taxonomy { nodes?: { name?: string }[] }

interface MecumLot {
  databaseId?: number;
  title?: string;
  uri?: string;
  lotNumber?: string;
  hammerPrice?: string;
  hideHammerPrice?: string;
  hideSaleResult?: string;
  highEstimate?: string;
  lowEstimate?: string;
  odometer?: string;
  odometerUnits?: string;
  isActualMiles?: string;
  vinSerial?: string;
  engine?: string;
  transmission?: string;
  color?: string;
  makes?: Taxonomy;
  models?: Taxonomy;
  lotYears?: Taxonomy;
  runDates?: Taxonomy;
  auction?: { nodes?: { title?: string }[] };
  featuredImage?: { node?: { mediaItemUrl?: string } };
}

/** WPGraphQL returns every custom field as a string, and an absent one as "". */
function num(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(String(value).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A WordPress boolean-ish custom field: "" is false, anything else is true. */
function flag(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim() !== '' && value !== '0';
}

const first = (t: Taxonomy | undefined): string | null => t?.nodes?.[0]?.name ?? null;

/**
 * The odometer in miles, or null.
 *
 * `odometerUnits` is "M" or "K", and storing a kilometre figure as miles ranks
 * a 20,900 km car ahead of a genuinely lower-mileage one with nothing
 * downstream able to detect it.
 */
export function odometerMiles(lot: MecumLot): number | null {
  const raw = num(lot.odometer);
  if (raw === null) return null;
  return /^k/i.test(lot.odometerUnits ?? '') ? Math.round(raw * 0.621371) : raw;
}

/**
 * Whether a lot is a car rather than a piece of memorabilia.
 *
 * Mecum sells signs, pumps and pedal cars in the same catalogue, and they are
 * titled like vehicles: "2014 Porsche Single-Sided Plastic Lighted Sign" sold
 * for $960 and parses as a 2014 Porsche. Two signals agree here and both are
 * required, because either alone is wrong somewhere: a real car is filed under
 * a make taxonomy and memorabilia is not, and the shared non-vehicle phrase
 * list catches the rest.
 */
export function isVehicle(lot: MecumLot): boolean {
  if (isNonVehicle(lot.title ?? '')) return false;
  return first(lot.makes) !== null;
}

export const mecum: SourceAdapter = {
  source: getSource('mecum')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    const terms = query.models?.length
      ? query.models.map((m) => [query.make, m].filter(Boolean).join(' '))
      : [query.make ?? ''];

    for (const term of terms) {
      let after: string | null = null;
      let hidden = 0;
      let memorabilia = 0;

      // Five pages of a hundred is five hundred lots per term, past what the
      // house has catalogued for any single model.
      for (let page = 0; page < 5; page += 1) {
        try {
          const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: LOTS_QUERY, variables: { first: 100, after, search: term || null } }),
            signal: AbortSignal.timeout(45_000),
          });
          if (!res.ok) {
            ctx.log(`mecum "${term}" HTTP ${res.status}`);
            break;
          }

          const body = (await res.json()) as {
            errors?: { message?: string }[];
            data?: { lots?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; edges?: { node?: MecumLot }[] } };
          };
          if (body.errors?.length) {
            ctx.log(`mecum "${term}" GraphQL: ${body.errors[0]?.message ?? 'error'}`);
            break;
          }

          const edges = body.data?.lots?.edges ?? [];
          if (edges.length === 0) break;
          let kept = 0;

          for (const edge of edges) {
            const lot = edge.node;
            if (!lot?.databaseId || !lot.title) continue;
            if (!isVehicle(lot)) { memorabilia += 1; continue; }

            /**
             * A consignor can withhold the result, and the field is then still
             * populated. Publishing it anyway would put a number in the sold
             * column that the house deliberately did not print.
             */
            if (flag(lot.hideHammerPrice) || flag(lot.hideSaleResult)) { hidden += 1; continue; }
            const hammer = num(lot.hammerPrice);
            if (hammer === null) continue;

            const id = `mecum:${lot.databaseId}`;
            if (out.has(id)) continue;

            const miles = odometerMiles(lot);
            const year = Number(first(lot.lotYears) ?? '') || parseYear(lot.title);
            const vin = lot.vinSerial?.trim() ?? '';

            out.set(id, {
              id,
              sourceId: 'mecum',
              sourceListingId: String(lot.databaseId),
              url: lot.uri ? `https://www.mecum.com${lot.uri}` : null,
              title: lot.title,
              year: year && year > 1900 ? year : null,
              make: first(lot.makes),
              model: first(lot.models),
              trim: null,
              series: null,
              /**
               * Pre-1981 cars carry a chassis number, not a 17-character VIN,
               * and this catalogue is full of them. Storing one in the VIN
               * column would let dedupe match two different cars on a short
               * serial that is only unique within a marque.
               */
              vin: isValidVin(vin) ? vin.toUpperCase() : null,
              price: hammer,
              priceKind: 'sold',
              currency: 'USD',
              mileage: miles,
              mileageIsRounded: isRoundedMileage(miles),
              // The sale, not a place: Mecum names its auctions for the city
              // they run in ("Monterey 2026"), which is the nearest thing to a
              // location a lot record carries.
              location: lot.auction?.nodes?.[0]?.title ?? null,
              sellerType: 'auction',
              engine: lot.engine || null,
              transmission: parseTransmission(lot.transmission),
              exteriorColor: canonicalColor(lot.color),
              // The date the lot crossed the block, which is the date a sold
              // price belongs to. The auction's own range spans several days.
              eventDate: first(lot.runDates),
              imageUrl: lot.featuredImage?.node?.mediaItemUrl ?? null,
              firstSeen: now,
              lastSeen: now,
              raw: {
                lotNumber: lot.lotNumber || undefined,
                highEstimate: num(lot.highEstimate) ?? undefined,
                lowEstimate: num(lot.lowEstimate) ?? undefined,
                // "Actual miles" is the house stating the odometer is believed
                // true, which is not a given on a fifty-year-old car.
                actualMiles: flag(lot.isActualMiles) || undefined,
                chassisNumber: !isValidVin(vin) && vin ? vin : undefined,
                auction: lot.auction?.nodes?.[0]?.title,
              },
            });
            kept += 1;
          }

          const info = body.data?.lots?.pageInfo;
          ctx.log(`mecum ${(term || 'all').padEnd(20)} p${page + 1} ${String(edges.length).padStart(3)} lots, ${kept} kept (pool ${out.size})`);
          if (!info?.hasNextPage || !info.endCursor) break;
          after = info.endCursor;
        } catch (e) {
          ctx.log(`mecum "${term}" FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }
      }

      if (memorabilia) ctx.log(`mecum "${term}": ${memorabilia} lots are memorabilia, not cars`);
      if (hidden) ctx.log(`mecum "${term}": ${hidden} results the consignor withheld`);
    }

    return [...out.values()].map(makeListing);
  },
};
