import type { Listing, SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { isNonVehicle, isRoundedMileage, isValidVin, parseModel, parseYear } from '../core/normalize.js';
import { parseTransmission } from '../core/facets.js';
import { canonicalColor } from '../core/canonical.js';
import { findRecords } from './nextjs.js';

const HOME = 'https://www.barrett-jackson.com/';

export interface BarrettLot {
  title?: string;
  price?: string | number;
  is_sold?: boolean;
  year?: string | number;
  make?: string;
  model?: string;
  style?: string;
  vin?: string;
  exterior_color?: string;
  transmission_type_name?: string;
  event_slug?: string;
  lot_number?: string;
  store_name?: string;
  run_datetime?: string;
  slug?: string;
  item_id?: string | number;
  main_image_url?: string;
  is_charity?: boolean;
}

const amount = (value: string | number | undefined): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** Barrett-Jackson's embedded homepage results, reduced to completed vehicles. */
export function parseBarrettLots(lots: BarrettLot[]): Listing[] {
  const now = new Date().toISOString();
  const out = new Map<string, ListingDraft>();

  for (const lot of lots) {
    if (!lot.item_id || !lot.title || !lot.is_sold || isNonVehicle(lot.title)) continue;
    const price = amount(lot.price);
    if (price === null) continue;

    const id = `barrettjackson:${lot.item_id}`;
    if (out.has(id)) continue;
    const year = Number(lot.year) || parseYear(lot.title);
    const make = lot.make?.trim() || null;
    const vin = lot.vin?.trim() ?? '';
    const slug = lot.slug?.replace(/^\/+|\/+$/g, '');
    const event = lot.event_slug?.replace(/^\/+|\/+$/g, '');

    out.set(id, {
      id,
      sourceId: 'barrettjackson',
      sourceListingId: String(lot.item_id),
      url: event && slug ? `${HOME}${event}/docket/vehicle/${slug}-${lot.item_id}` : HOME,
      title: lot.title,
      year: year !== null && year >= 1900 ? year : null,
      make,
      model: lot.model?.trim() || parseModel(lot.title, make),
      trim: lot.style?.trim() || null,
      vin: isValidVin(vin) ? vin.toUpperCase() : null,
      price,
      priceKind: 'sold',
      currency: 'USD',
      mileage: null,
      mileageIsRounded: isRoundedMileage(null),
      location: lot.store_name ?? null,
      sellerType: 'auction',
      transmission: parseTransmission(lot.transmission_type_name),
      exteriorColor: canonicalColor(lot.exterior_color),
      eventDate: lot.run_datetime ?? null,
      imageUrl: lot.main_image_url ?? null,
      firstSeen: now,
      lastSeen: now,
      raw: { lotNumber: lot.lot_number, charity: lot.is_charity || undefined },
    });
  }

  return [...out.values()].map(makeListing);
}

function same(value: string | null, wanted: string): boolean {
  return value !== null && value.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export const barrettjackson: SourceAdapter = {
  source: getSource('barrettjackson')!,

  async search(query, ctx) {
    const html = await ctx.fetchText(HOME, { transport: 'fetch' });
    const records = findRecords<BarrettLot>(html, 'vin');
    let rows = parseBarrettLots(records);
    if (query.make) rows = rows.filter((row) => same(row.make, query.make!));
    if (query.models?.length) rows = rows.filter((row) => query.models!.some((model) => same(row.model, model)));
    if (query.yearMin !== undefined) rows = rows.filter((row) => row.year !== null && row.year >= query.yearMin!);
    if (query.yearMax !== undefined) rows = rows.filter((row) => row.year !== null && row.year <= query.yearMax!);
    ctx.log(`barrettjackson: ${records.length} embedded lots, ${rows.length} completed vehicles match`);
    return rows;
  },
};
