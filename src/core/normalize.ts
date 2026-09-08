import type { Listing, RejectedListing } from './types.js';
import { loadVocabulary } from '../nl/vocabulary.js';

/**
 * Normalization and plausibility.
 *
 * Every rule in this file exists because a specific wrong record got through
 * without it. Wrong data that looks plausible is worse than an error, because
 * an error stops the run and a plausible wrong number ships to a user.
 */

/** Makes recognized when parsing a free-text title. VIN decode is the authority; this is the fallback. */
const MAKES = [
  'Acura', 'Alfa Romeo', 'Aston Martin', 'Audi', 'Bentley', 'BMW', 'Bugatti', 'Buick', 'Cadillac',
  'Chevrolet', 'Chrysler', 'Citroen', 'Dodge', 'Ferrari', 'Fiat', 'Fisker', 'Ford', 'Genesis', 'GMC',
  'Honda', 'Hummer', 'Hyundai', 'Infiniti', 'Isuzu', 'Jaguar', 'Jeep', 'Kia', 'Koenigsegg', 'Lamborghini',
  'Land Rover', 'Lexus', 'Lincoln', 'Lotus', 'Lucid', 'Maserati', 'Maybach', 'Mazda', 'McLaren',
  'Mercedes-Benz', 'Mercury', 'MINI', 'Mitsubishi', 'Nissan', 'Oldsmobile', 'Opel', 'Pagani', 'Peugeot',
  'Plymouth', 'Polestar', 'Pontiac', 'Porsche', 'Ram', 'Renault', 'Rivian', 'Rolls-Royce', 'Saab',
  'Saturn', 'Scion', 'Seat', 'Skoda', 'Smart', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Vauxhall',
  'Volkswagen', 'Volvo',
];

/** Aliases people and sites actually type. */
const MAKE_ALIASES: Record<string, string> = {
  chevy: 'Chevrolet',
  vw: 'Volkswagen',
  mercedes: 'Mercedes-Benz',
  benz: 'Mercedes-Benz',
  merc: 'Mercedes-Benz',
  'land-rover': 'Land Rover',
  landrover: 'Land Rover',
  'rolls royce': 'Rolls-Royce',
  'alfa': 'Alfa Romeo',
  'g wagon': 'Mercedes-Benz',
  'g-wagon': 'Mercedes-Benz',
  gwagon: 'Mercedes-Benz',
  'g wagen': 'Mercedes-Benz',
};

/**
 * Bring a Trailer and similar auction sites list memorabilia alongside cars. A
 * "BMW i8 Full-Scale Display Model" sold for $2,700 and parsed as an i8, which
 * then dragged the i8 median down by thousands.
 */
const NON_VEHICLE = /\b(display model|scale model|model car|poster|sign|neon|memorabilia|literature|brochure|manual|toy|pedal car|go.?kart|wheels?|tires?|engine|transmission|parts|seats?|badge|emblem|artwork|painting|print|clock|watch|helmet|jacket)\b/i;

/** Mileage values that are display roundings rather than odometer readings. */
const ROUND_MILEAGE = new Set([100, 500, 1000, 2000, 3000, 4000, 5000, 10000, 15000, 20000, 25000, 50000, 100000]);

export function parseYear(title: string): number | null {
  const m = title.match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  if (!m?.[1]) return null;
  const y = Number(m[1]);
  const next = new Date().getFullYear() + 2;
  return y >= 1950 && y <= next ? y : null;
}

export function parseMake(title: string): string | null {
  const t = title.toLowerCase();
  for (const [alias, make] of Object.entries(MAKE_ALIASES)) {
    if (t.includes(alias)) return make;
  }
  // Longest match first so "Land Rover" wins over a bare token and
  // "Mercedes-Benz" is not shadowed by a partial.
  const sorted = [...MAKES].sort((a, b) => b.length - a.length);
  for (const make of sorted) {
    if (t.includes(make.toLowerCase())) return make;
  }
  return null;
}

/**
 * Pulls a numeric price out of text.
 *
 * Only ever call this on the text of a specific price element. Scanning a whole
 * tile for the first `$n,nnn` produced a "2026 Porsche 911 Targa 4 GTS
 * Cabriolet, 1,000 mi, $25,476" whose real comparables were $185,069 and
 * $243,475. The figure was a monthly payment or a stale field.
 */
/**
 * Reads the model out of a listing title.
 *
 * Needed because sources lie about this field in a specific, damaging way: some
 * repeat the make in it. An import arrived with 147 Ferraris all carrying
 * `model: "Ferrari"`, which collapsed a California, a 488 and an 812 Superfast
 * into one peer group whose median was $709,000, and the plausibility check
 * then rejected the California as a parse error. A model field that is really
 * the make is worse than an empty one, so both are treated as absent and the
 * title is re-read.
 *
 * The catalogue is consulted first, then the token after the make, which covers
 * models the vPIC catalogue spells differently from the seller.
 */
export function parseModel(title: string, make: string | null): string | null {
  if (!title) return null;
  const text = title.toLowerCase();
  const makeLower = make?.toLowerCase() ?? null;

  if (makeLower) {
    const catalogue = loadVocabulary().models[makeLower] ?? [];
    // Longest first, so "Land Cruiser" is not read as "Land" and "911 Turbo"
    // does not lose to "911".
    const hit = [...catalogue]
      .sort((a, b) => b.length - a.length)
      .find((m) => new RegExp(`\\b${m.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
    if (hit) return hit;
  }

  // Fall back to the word after the make, minus a leading year.
  const stripped = title.replace(/^\s*(19|20)\d{2}\s+/, '');
  const afterMake = makeLower && stripped.toLowerCase().startsWith(makeLower)
    ? stripped.slice(makeLower.length).trim()
    : stripped;
  const token = afterMake.split(/[\s,/]+/).find((w) => w.length > 0 && w.toLowerCase() !== makeLower);
  if (!token) return null;

  // "Base", "AWD" and the like are trim noise, not a model.
  if (/^(base|awd|rwd|4wd|fwd|coupe|sedan|suv|convertible|cabriolet|spider|spyder|roadster|wagon|used|new)$/i.test(token)) {
    return null;
  }
  return token.replace(/[^A-Za-z0-9-]/g, '') || null;
}

/**
 * The model as it should be stored, given what the source claimed.
 *
 * A model equal to the make is the source giving up, and is discarded.
 */
/**
 * One spelling per model.
 *
 * Sources disagree on case, and the index carried "Macan" and "macan" as two
 * values: they split every facet count, every peer group and every comps
 * lookup, while looking like one model to a reader. Alphanumeric model
 * designations (911, GT-R, MX-5) keep their own casing because title-casing
 * them produces nonsense.
 */
export function canonicalModel(model: string | null): string | null {
  const m = model?.trim();
  if (!m) return null;
  if (/\d/.test(m) || m === m.toUpperCase()) return m;
  return m.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function resolveModel(title: string, make: string | null, claimed: string | null): string | null {
  const bad = !claimed
    || (make !== null && claimed.trim().toLowerCase() === make.trim().toLowerCase())
    || claimed.trim().length === 0;
  return bad ? parseModel(title, make) : claimed;
}

export function parseMoney(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/\$?\s*(\d{3,})/);
  return m?.[1] ? Number(m[1]) : null;
}

export function parseMileage(text: string | null | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/,/g, '');
  const k = cleaned.match(/(\d+(?:\.\d+)?)\s*k\b/i);
  if (k?.[1]) return Math.round(Number(k[1]) * 1000);
  const m = cleaned.match(/(\d{1,7})\s*(?:mi|miles|km)?\b/i);
  return m?.[1] ? Number(m[1]) : null;
}

export function isRoundedMileage(miles: number | null): boolean {
  if (miles === null) return false;
  return ROUND_MILEAGE.has(miles);
}

export function isNonVehicle(title: string): boolean {
  return NON_VEHICLE.test(title);
}

/** A VIN is 17 characters and never contains I, O or Q. */
export function isValidVin(vin: string | null | undefined): vin is string {
  if (!vin) return false;
  return /^[A-HJ-NPR-Z0-9]{17}$/i.test(vin.trim());
}

/**
 * Self-calibrating price plausibility.
 *
 * A flat floor does not work. An $8,000 floor passes a $25,476 "911 Targa 4 GTS"
 * and rejects a legitimately cheap economy car. The only floor that generalizes
 * is one derived from the market itself: hold a listing against the median of
 * its own peer group.
 *
 * Peer group is (make, model, year within +/- 2). Below `MIN_PEERS`
 * observations there is no reliable median, so we fall back to a very low
 * absolute floor that only catches obvious garbage.
 */
export class PlausibilityModel {
  private peers = new Map<string, number[]>();
  static readonly MIN_PEERS = 5;
  /** Anything below this fraction of the peer median is treated as a parse error. */
  static readonly FLOOR_RATIO = 0.35;
  /** Anything above this multiple of the peer median is treated as a parse error. */
  static readonly CEILING_RATIO = 4;
  static readonly ABSOLUTE_FLOOR = 500;

  private key(make: string | null, model: string | null, year: number | null): string {
    const bucket = year === null ? 'x' : String(Math.round(year / 2) * 2);
    return `${(make ?? '?').toLowerCase()}|${(model ?? '?').toLowerCase()}|${bucket}`;
  }

  /** Feed observed prices in before checking. Only 'ask' and 'sold' belong here, never live bids. */
  observe(listing: Pick<Listing, 'make' | 'model' | 'year' | 'price' | 'priceKind'>): void {
    if (listing.price === null || listing.priceKind === 'bid') return;
    const k = this.key(listing.make, listing.model, listing.year);
    const arr = this.peers.get(k);
    if (arr) arr.push(listing.price);
    else this.peers.set(k, [listing.price]);
  }

  median(make: string | null, model: string | null, year: number | null): number | null {
    const arr = this.peers.get(this.key(make, model, year));
    if (!arr || arr.length < PlausibilityModel.MIN_PEERS) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }

  /** Returns a rejection reason, or null when the price is plausible. */
  check(listing: Pick<Listing, 'make' | 'model' | 'year' | 'price' | 'priceKind'>): string | null {
    const { price } = listing;
    if (price === null) return null;
    if (price < PlausibilityModel.ABSOLUTE_FLOOR) return 'price below absolute floor (bad parse)';
    // A live auction bid is legitimately far below market until the auction ends.
    if (listing.priceKind === 'bid') return null;
    const med = this.median(listing.make, listing.model, listing.year);
    if (med === null) return null;
    if (price < med * PlausibilityModel.FLOOR_RATIO) {
      return `price ${price} is below ${Math.round(PlausibilityModel.FLOOR_RATIO * 100)}% of peer median ${Math.round(med)} (likely a payment or a stale field)`;
    }
    if (price > med * PlausibilityModel.CEILING_RATIO) {
      return `price ${price} is over ${PlausibilityModel.CEILING_RATIO}x peer median ${Math.round(med)} (likely an MSRP or a typo)`;
    }
    return null;
  }
}

export interface ValidationResult {
  kept: Listing[];
  rejected: RejectedListing[];
}

/**
 * Applies every plausibility rule and returns kept and rejected records.
 *
 * Rejects are returned rather than dropped. Silent filtering hides parser rot:
 * both the Mercedes that got into a Porsche dataset and the $25,476 "911" were
 * caught by reading a rejects file with a `why` field.
 */
export function validate(listings: Listing[]): ValidationResult {
  /**
   * Repair the model field BEFORE building peer groups. The plausibility check
   * is only as good as its peer definition, and a batch where the model column
   * holds the make silently merges every car of that marque into one group.
   */
  const repaired = listings.map((l) => {
    const fixed = canonicalModel(resolveModel(l.title, l.make, l.model));
    const series = l.series?.trim() ? l.series.trim() : null;
    return fixed === l.model && series === l.series ? l : { ...l, model: fixed, series };
  });

  const model = new PlausibilityModel();
  for (const l of repaired) model.observe(l);

  const kept: Listing[] = [];
  const rejected: RejectedListing[] = [];

  for (const l of repaired) {
    const why =
      !l.title ? 'missing title'
      : isNonVehicle(l.title) ? 'not a vehicle (memorabilia or parts)'
      : l.price === null ? 'missing price'
      : l.vin !== null && !isValidVin(l.vin) ? 'malformed VIN'
      : model.check(l);

    if (why) rejected.push({ ...l, why });
    else kept.push(l);
  }

  return { kept, rejected };
}

/**
 * Asserts that a batch does not carry the signature of a pairing bug.
 *
 * Pairing prices to listings by page-wide regex gave every car in a model line
 * the same price: a 2019 i8 Roadster was recorded as selling for $2,700. That
 * failure is invisible in the output but obvious in this ratio, so it is
 * checked after every extraction rather than trusted.
 */
export function checkDistinctPrices(listings: Listing[]): { ok: boolean; message: string } {
  const priced = listings.filter((l) => l.price !== null);
  if (priced.length < 3) return { ok: true, message: 'too few priced records to judge' };
  const distinct = new Set(priced.map((l) => l.price)).size;
  const ratio = distinct / priced.length;
  if (ratio < 0.2) {
    return {
      ok: false,
      message: `SUSPECT: ${priced.length} priced records but only ${distinct} distinct prices. This is the signature of a mispairing bug, not a coincidence.`,
    };
  }
  return { ok: true, message: `${priced.length} records, ${distinct} distinct prices` };
}
