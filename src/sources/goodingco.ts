import type { Listing, PriceKind, SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { isNonVehicle, parseMake, parseModel, parseYear } from '../core/normalize.js';

const ENDPOINT = 'https://cdn.goodingco.com/graphql';
const ORIGIN = 'https://www.goodingco.com';

const LOTS_QUERY = `query GetVehiclesAndFilters(
  $filtersInput: FiltersInput!
  $pageNumber: Int
  $sortBy: SortBy!
  $searchQuery: String
  $hitsPerPage: Int
) {
  getVehicles(
    filtersInput: $filtersInput
    pageNumber: $pageNumber
    sortBy: $sortBy
    searchQuery: $searchQuery
    hitsPerPage: $hitsPerPage
  ) {
    vehicles {
      objectID make modelYear model title itemType slug
      salePrice askingPrice askingPriceOverride privateSalesPrice currency
      lowEstimate highEstimate auctionType auctionName lotNumber
      activeAuction auctionStartDate auctionEndDate
      cloudinaryImages { public_id }
    }
    page nbPages nbHits
  }
}`;

export interface GoodingLot {
  objectID?: string;
  make?: string;
  modelYear?: number;
  model?: string;
  title?: string;
  itemType?: string;
  slug?: string;
  salePrice?: string | number | null;
  askingPrice?: string | number | null;
  askingPriceOverride?: string | null;
  privateSalesPrice?: boolean | null;
  currency?: string;
  lowEstimate?: number | null;
  highEstimate?: number | null;
  auctionType?: string;
  auctionName?: string;
  lotNumber?: number | string | null;
  activeAuction?: string | boolean | null;
  auctionStartDate?: string | null;
  auctionEndDate?: string | null;
  cloudinaryImages?: { public_id?: string }[];
}

function amount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** A hammer price is a sale; an asking price is an ask. Estimates are neither. */
export function goodingPrice(lot: GoodingLot): { price: number; kind: PriceKind } | null {
  const sold = amount(lot.salePrice);
  if (sold !== null) return { price: sold, kind: 'sold' };
  const ask = amount(lot.askingPrice);
  if (ask !== null) return { price: ask, kind: 'ask' };
  return null;
}

function eventDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const n = Number(value);
  const date = Number.isFinite(n) ? new Date(n) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseGoodingLots(lots: GoodingLot[]): Listing[] {
  const now = new Date().toISOString();
  const out = new Map<string, ListingDraft>();

  for (const lot of lots) {
    if (!lot.objectID || !lot.title || lot.itemType?.toLowerCase() !== 'cars' || isNonVehicle(lot.title)) continue;
    const value = goodingPrice(lot);
    if (!value) continue;

    const id = `goodingco:${lot.objectID}`;
    if (out.has(id)) continue;
    const make = lot.make?.trim() || parseMake(lot.title);
    const year = Number(lot.modelYear) || parseYear(lot.title);
    const imageId = lot.cloudinaryImages?.find((image) => image.public_id)?.public_id;

    out.set(id, {
      id,
      sourceId: 'goodingco',
      sourceListingId: lot.objectID,
      url: lot.slug ? `${ORIGIN}/lot/${lot.slug.replace(/^\/+|\/+$/g, '')}` : ORIGIN,
      title: lot.title,
      year: year && year >= 1800 ? year : null,
      make,
      model: lot.model?.trim() || parseModel(lot.title, make),
      price: value.price,
      priceKind: value.kind,
      currency: lot.currency || 'USD',
      sellerType: value.kind === 'sold' ? 'auction' : 'dealer',
      location: lot.auctionName ?? null,
      eventDate: value.kind === 'sold' ? eventDate(lot.auctionEndDate) : null,
      imageUrl: imageId ? `https://media.goodingco.com/image/upload/c_fill,g_auto,q_85,w_1200/${imageId}` : null,
      firstSeen: now,
      lastSeen: now,
      raw: {
        auctionType: lot.auctionType,
        lotNumber: lot.lotNumber,
        lowEstimate: lot.lowEstimate,
        highEstimate: lot.highEstimate,
        askingPriceOverride: lot.askingPriceOverride,
        activeAuction: lot.activeAuction,
      },
    });
  }

  return [...out.values()].map(makeListing);
}

export const goodingco: SourceAdapter = {
  source: getSource('goodingco')!,

  async search(query, ctx) {
    if (!query.make) {
      ctx.log('goodingco: needs a make, skipping an unbounded archive crawl');
      return [];
    }

    const out = new Map<string, Listing>();
    const terms = query.models?.length
      ? query.models.map((model) => `${query.make} ${model}`)
      : [query.make];

    for (const term of terms) {
      for (let page = 0; page < 15; page += 1) {
        try {
          const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer' },
            body: JSON.stringify({
              operationName: 'GetVehiclesAndFilters',
              query: LOTS_QUERY,
              variables: {
                filtersInput: {
                  make: [query.make],
                  itemType: ['Cars'],
                  auctionType: [], venue: [], auctionYear: [],
                  ...(query.yearMin !== undefined || query.yearMax !== undefined
                    ? { year: { start: String(query.yearMin ?? 1800), end: String(query.yearMax ?? new Date().getUTCFullYear() + 2) } }
                    : {}),
                },
                pageNumber: page,
                sortBy: 'DEFAULT',
                searchQuery: term,
                hitsPerPage: 100,
              },
            }),
            signal: AbortSignal.timeout(45_000),
          });
          if (!res.ok) {
            ctx.log(`goodingco "${term}" HTTP ${res.status}`);
            break;
          }

          const body = (await res.json()) as {
            errors?: { message?: string }[];
            data?: { getVehicles?: { vehicles?: GoodingLot[]; page?: number; nbPages?: number; nbHits?: number } };
          };
          if (body.errors?.length) {
            ctx.log(`goodingco "${term}" GraphQL: ${body.errors[0]?.message ?? 'error'}`);
            break;
          }
          const pageData = body.data?.getVehicles;
          const lots = pageData?.vehicles ?? [];
          if (lots.length === 0) break;
          const rows = parseGoodingLots(lots);
          for (const row of rows) {
            if (query.priceMin !== undefined && (row.price === null || row.price < query.priceMin)) continue;
            if (query.priceMax !== undefined && (row.price === null || row.price > query.priceMax)) continue;
            out.set(row.id, row);
          }
          ctx.log(`goodingco "${term}" p${page + 1} ${lots.length} lots, ${rows.length} priced vehicles (pool ${out.size})`);
          if (page + 1 >= (pageData?.nbPages ?? 0) || lots.length < 100) break;
        } catch (error) {
          ctx.log(`goodingco "${term}" FAILED: ${(error as Error).message.split('\n')[0]}`);
          break;
        }
      }
    }

    return [...out.values()];
  },
};
