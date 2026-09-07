import type { Listing } from '../core/types.js';
import type { Store } from '../store/db.js';
import { isValidVin } from '../core/normalize.js';

/**
 * VIN decoding via NHTSA vPIC. Free, no key, no observed rate limit.
 *
 * Trim normalization is the genuinely hard problem in this category, and this
 * endpoint solves most of it for nothing. The field that matters is `Series`,
 * which returns the factory platform code: "Type 95B" separates Macan
 * generations, and the same field separates 991 from 992 and 981 from 982.
 * Generation is the axis that actually moves price, so a listing carrying it is
 * worth far more than one carrying a marketing trim string.
 */

const ENDPOINT = 'https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues';

export interface VinDecode {
  ModelYear?: string;
  Make?: string;
  Model?: string;
  Trim?: string;
  Series?: string;
  BodyClass?: string;
  DriveType?: string;
  EngineCylinders?: string;
  DisplacementL?: string;
  FuelTypePrimary?: string;
  PlantCountry?: string;
  ErrorCode?: string;
  ErrorText?: string;
}

export async function decodeVin(vin: string, store?: Store): Promise<VinDecode | null> {
  if (!isValidVin(vin)) return null;
  const key = vin.toUpperCase();

  const cached = store?.getVinDecode<VinDecode>(key);
  if (cached) return cached;

  try {
    const res = await fetch(`${ENDPOINT}/${key}?format=json`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { Results?: VinDecode[] };
    const decoded = body.Results?.[0];
    if (!decoded) return null;
    store?.cacheVinDecode(key, decoded);
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Fills in what the listing did not carry, and never overwrites what it did.
 *
 * A source's own trim string is what a buyer will see on that site, so it wins
 * on conflict. `series` is the exception: no listing site publishes it, so it
 * can only ever come from here.
 */
export async function enrichListing(listing: Listing, store?: Store): Promise<Listing> {
  if (!isValidVin(listing.vin)) return listing;
  const d = await decodeVin(listing.vin, store);
  if (!d || d.ErrorCode?.startsWith('1')) return listing;

  return {
    ...listing,
    year: listing.year ?? (d.ModelYear ? Number(d.ModelYear) : null),
    make: listing.make ?? d.Make ?? null,
    model: listing.model ?? d.Model ?? null,
    trim: listing.trim ?? d.Trim ?? null,
    series: d.Series ?? listing.series,
    bodyType: listing.bodyType ?? d.BodyClass ?? null,
    fuelType: listing.fuelType ?? d.FuelTypePrimary ?? null,
  };
}

/** Enriches a batch with a small concurrency cap, since vPIC is a shared public service. */
export async function enrichAll(listings: Listing[], store?: Store, concurrency = 6): Promise<Listing[]> {
  const out: Listing[] = [];
  for (let i = 0; i < listings.length; i += concurrency) {
    const batch = listings.slice(i, i + concurrency);
    out.push(...(await Promise.all(batch.map((l) => enrichListing(l, store)))));
  }
  return out;
}
