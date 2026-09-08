import type { Listing } from '../core/types.js';
import type { CarStore } from '../store/store.js';
import { isValidVin } from '../core/normalize.js';
import { parseDrivetrain, parseTransmission } from '../core/facets.js';

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

  /**
   * The mechanical facets. Every one of these is published by vPIC for free and
   * by almost no listing site at all, which makes VIN decode the cheapest
   * source of filterable detail available: one call fills drivetrain, doors,
   * seats, cylinders, displacement and transmission for a car whose listing
   * page mentioned none of them.
   */
  TransmissionStyle?: string;
  TransmissionSpeeds?: string;
  Doors?: string;
  Seats?: string;
  EngineHP?: string;
  EngineModel?: string;
  Turbo?: string;
  ElectrificationLevel?: string;
  BatteryKWh?: string;
  ChargerLevel?: string;
  /** Advanced driver-assistance columns, folded into `options`. */
  AdaptiveCruiseControl?: string;
  BlindSpotMon?: string;
  LaneDepartureWarning?: string;
  LaneKeepSystem?: string;
  ForwardCollisionWarning?: string;
  ParkAssist?: string;
  RearVisibilitySystem?: string;
  KeylessIgnition?: string;
  TractionControl?: string;
  ESC?: string;
}

const num = (v: string | undefined): number | null => {
  if (!v) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Equipment vPIC reports as fitted.
 *
 * "Standard" means the car has it. "Optional" means the trim COULD have it,
 * which is not the same claim, so only Standard is recorded: an options list
 * that might be wrong is worse than a short one that is right.
 */
const ADAS_FIELDS: [keyof VinDecode, string][] = [
  ['AdaptiveCruiseControl', 'Adaptive cruise control'],
  ['BlindSpotMon', 'Blind spot monitor'],
  ['LaneDepartureWarning', 'Lane departure warning'],
  ['LaneKeepSystem', 'Lane keep assist'],
  ['ForwardCollisionWarning', 'Forward collision warning'],
  ['ParkAssist', 'Parking assist'],
  ['RearVisibilitySystem', 'Backup camera'],
  ['KeylessIgnition', 'Keyless ignition'],
];

export function optionsFromDecode(d: VinDecode): string[] {
  const out: string[] = [];
  for (const [field, label] of ADAS_FIELDS) {
    if (String(d[field] ?? '').toLowerCase().startsWith('standard')) out.push(label);
  }
  if (String(d.Turbo ?? '').toLowerCase() === 'yes') out.push('Turbocharged');
  return out;
}

export async function decodeVin(vin: string, store?: CarStore): Promise<VinDecode | null> {
  if (!isValidVin(vin)) return null;
  const key = vin.toUpperCase();

  const cached = store ? await store.getVinDecode<VinDecode>(key) : null;
  if (cached) return cached;

  try {
    const res = await fetch(`${ENDPOINT}/${key}?format=json`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { Results?: VinDecode[] };
    const decoded = body.Results?.[0];
    if (!decoded) return null;
    await store?.cacheVinDecode(key, decoded);
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
export async function enrichListing(listing: Listing, store?: CarStore): Promise<Listing> {
  if (!isValidVin(listing.vin)) return listing;
  const d = await decodeVin(listing.vin, store);
  if (!d || d.ErrorCode?.startsWith('1')) return listing;

  const engine = [
    d.DisplacementL ? `${Number(d.DisplacementL).toFixed(1)}L` : null,
    d.EngineCylinders ? `${d.EngineCylinders}-cyl` : null,
    String(d.Turbo ?? '').toLowerCase() === 'yes' ? 'turbo' : null,
    d.EngineHP ? `${Math.round(Number(d.EngineHP))} hp` : null,
  ].filter(Boolean).join(' ');

  const options = optionsFromDecode(d);
  const electrified = String(d.ElectrificationLevel ?? '').toLowerCase();

  return {
    ...listing,
    year: listing.year ?? (d.ModelYear ? Number(d.ModelYear) : null),
    make: listing.make ?? d.Make ?? null,
    model: listing.model ?? d.Model ?? null,
    trim: listing.trim ?? d.Trim ?? null,
    series: d.Series ?? listing.series,
    bodyType: listing.bodyType ?? d.BodyClass ?? null,
    fuelType: listing.fuelType ?? d.FuelTypePrimary ?? null,

    // The listing's own words win where it spoke; vPIC fills the silence.
    drivetrain: listing.drivetrain ?? parseDrivetrain(d.DriveType),
    transmission: listing.transmission ?? parseTransmission(
      [d.TransmissionStyle, d.TransmissionSpeeds ? `${d.TransmissionSpeeds}-speed` : ''].join(' '),
    ),
    cylinders: listing.cylinders ?? num(d.EngineCylinders),
    displacementL: listing.displacementL ?? num(d.DisplacementL),
    doors: listing.doors ?? num(d.Doors),
    seats: listing.seats ?? num(d.Seats),
    engine: listing.engine ?? (engine || null),
    batteryKwh: listing.batteryKwh ?? num(d.BatteryKWh),
    // vPIC names the assembly plant's country, which is the only import signal
    // available for free. It is a manufacturing fact, not a title brand.
    isImport: listing.isImport ?? (d.PlantCountry ? !/united states/i.test(d.PlantCountry) : null),

    options: listing.options ?? (options.length ? options : null),
    ...(electrified.includes('bev') || electrified.includes('phev')
      ? { fuelType: listing.fuelType ?? (electrified.includes('bev') ? 'Electric' : 'Hybrid') }
      : {}),
  } as Listing;
}

/** Enriches a batch with a small concurrency cap, since vPIC is a shared public service. */
export async function enrichAll(listings: Listing[], store?: CarStore, concurrency = 6): Promise<Listing[]> {
  const out: Listing[] = [];
  for (let i = 0; i < listings.length; i += concurrency) {
    const batch = listings.slice(i, i + concurrency);
    out.push(...(await Promise.all(batch.map((l) => enrichListing(l, store)))));
  }
  return out;
}
