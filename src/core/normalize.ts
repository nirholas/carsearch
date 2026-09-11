import type { Listing, RejectedListing } from './types.js';
import { loadVocabulary } from '../nl/vocabulary.js';
import { resolveTrim } from './trim.js';
import { canonicalBodyType, canonicalFuelType, canonicalColor, blankToNull } from './canonical.js';
import { BRANDED_TITLES } from './facets.js';

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
  // The classic and enthusiast marques the auction sources actually sell. Their
  // absence did not read as a gap: a title naming one of them simply fell
  // through to whatever make the row already carried, which is how a Shelby
  // Mustang ended up filed as a Mercedes.
  'AMC', 'Austin', 'Austin-Healey', 'Datsun', 'DeLorean', 'Delahaye', 'Duesenberg', 'Eagle',
  'Facel Vega', 'Hudson', 'International', 'Iso', 'Jensen', 'Lancia', 'Lotus', 'Marcos', 'MG',
  'Morgan', 'Nash', 'Packard', 'Panhard', 'Pierce-Arrow', 'Reliant', 'Riley', 'Shelby',
  'Studebaker', 'Sunbeam', 'Talbot', 'Triumph', 'TVR', 'Willys',
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
  // Steyr-Daimler-Puch built the G-Wagen and sold it under its own badge. A
  // Puch 230GE is a G-Class, and filing it separately splits the model.
  puch: 'Mercedes-Benz',
  // A Range Rover is a Land Rover. The bare marque "Rover" is deliberately not
  // in MAKES: it is vanishingly rare next to Range Rover, and listing it there
  // made every Range Rover a Rover.
  'range rover': 'Land Rover',
};

/**
 * Words that mean the advertised number is a financing term, not a price.
 *
 * Buy-here-pay-here dealers post the DOWN PAYMENT in the price field. A broad
 * Craigslist sweep returned 191 cars at exactly $1,500 and 131 at exactly
 * $2,000, including a 2018 Mercedes C300, because that is what they ask down.
 *
 * The plausibility model cannot catch these on its own: it holds a listing
 * against the median of its own peer group, and a sweep across every make has
 * too few peers per group to form one. But the seller says it outright in the
 * title, which makes this the rare case where the text is better evidence than
 * the statistics.
 */
const FINANCING_TERMS =
  /\b(\$?\d[\d,]*\s*(?:down|dwn)\b|down\s*payment|buy\s*here\s*pay\s*here|bhph|we\s*finance|no\s*credit|bad\s*credit|credito|financiamiento|se\s*financia|\$?\d[\d,]*\s*(?:\/|per\s*)(?:mo|month|week|wk)\b|weekly\s*payments?|monthly\s*payments?)/i;

/**
 * True when the listed price is a financing term rather than the car's price.
 *
 * Requires BOTH signals: the title has to advertise financing, and the price
 * has to be low enough that it cannot be the car. A dealer who mentions
 * financing on a genuinely cheap car is common and must not be thrown away,
 * so the threshold is deliberately conservative.
 */
export function isFinancingBait(title: string, price: number | null, year: number | null): boolean {
  if (price === null || !title) return false;
  if (!FINANCING_TERMS.test(title)) return false;

  // The number appears in the title right next to a down-payment marker, which
  // is the seller confirming it for us.
  const asWritten = price.toLocaleString('en-US');
  const nearDown = new RegExp(
    `\\$?(?:${price}|${asWritten.replace(/,/g, ',?')})\\s*(?:down|dwn|\\/\\s*(?:mo|month|week))`,
    'i',
  );
  if (nearDown.test(title)) return true;

  /**
   * Or the price is impossible for the age. A car under $3,000 that is under
   * fifteen years old and advertised with financing is quoting a payment; a
   * genuinely cheap old car is left alone.
   */
  const age = year === null ? null : new Date().getFullYear() - year;
  return price < 3000 && age !== null && age <= 15;
}

/**
 * Sellers admitting the car is not roadworthy.
 *
 * A cheap car with one of these words in the title is telling the truth, and
 * the age floor below must never touch it: a $900 project car is real data and
 * belongs in the index, labelled for what it is.
 */
const ADMITS_DAMAGE =
  /\b(salvage|rebuilt|parts?[\s-]?(?:only|out|car)|mechanic'?s? special|not running|non[\s-]?runner|no ?title|for parts|flood|wrecked|damaged?|project|as[\s-]?is|needs? work|blown|bad (?:engine|motor|trans)|junk|scrap|shell|rolling chassis)\b/i;

/**
 * A price that cannot be this car, whatever the peer group says.
 *
 * The peer-group model is the better instrument and stays the primary one, but
 * it needs five comparable listings to form a median, and a sweep across every
 * make on a classifieds site has too few per group. That left 232 rows like a
 * 2021 Ram TRX at $500, a 2018 Raptor at $553 and a Tesla Model Y at $550, all
 * of them lease or payment figures posted in the price field.
 *
 * The thresholds are deliberately far below any real market so that the rule
 * needs no calibration and can never be the reason a genuine bargain is hidden:
 * a ten-year-old car under $2,500 that does not admit damage does not exist,
 * and neither does any running car under $750.
 */
export function isImpossiblePriceForAge(
  title: string,
  price: number | null,
  year: number | null,
  /**
   * A branded title is the strongest possible statement that a low price is
   * real. Copart states one on every lot and its descriptions never contain a
   * damage word, so a 2020 salvage car at $2,000 would otherwise be thrown out
   * as impossible when it is the entire point of that source.
   */
  titleStatus?: string | null,
): boolean {
  if (price === null || year === null) return false;
  if (titleStatus && BRANDED_TITLES.includes(titleStatus as (typeof BRANDED_TITLES)[number])) return false;
  if (title && ADMITS_DAMAGE.test(title)) return false;
  const age = new Date().getFullYear() - year;
  if (age < 0) return false;
  if (age <= 10 && price < 2500) return true;
  return age <= 20 && price < 750;
}

/**
 * Bring a Trailer and similar auction sites list memorabilia alongside cars. A
 * "BMW i8 Full-Scale Display Model" sold for $2,700 and parsed as an i8, which
 * then dragged the i8 median down by thousands.
 */
const NON_VEHICLE = /\b(display model|scale model|model car|poster|sign|neon|memorabilia|literature|brochure|manual|toy|pedal car|go.?kart|wheels?|tires?|engine|transmission|parts|seats?|badge|emblem|artwork|painting|print|clock|watch|helmet|jacket)\b/i;

/**
 * Very low mileages that are advertising copy rather than an odometer reading.
 *
 * Above these the rule is arithmetic, see isRoundedMileage.
 */
const ROUND_MILEAGE = new Set([100, 500]);

/**
 * The year floor is 1900, not 1950.
 *
 * The old bound silently discarded the year on every pre-war car, and those are
 * not a rounding error on an index carrying Bring a Trailer: a 1932 Ford or a
 * 1949 Cadillac arrived with a null year, which drops it out of every year
 * filter, every cohort and every comps lookup while still sitting in the table.
 * A car whose year we refuse to read is worse than one we never crawled,
 * because it looks like coverage and behaves like a hole.
 */
export function parseYear(title: string): number | null {
  const m = title.match(/\b(19\d\d|20[0-4]\d)\b/);
  if (!m?.[1]) return null;
  const y = Number(m[1]);
  const next = new Date().getFullYear() + 2;
  return y >= 1900 && y <= next ? y : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word match, so an abbreviation cannot match inside a longer word. */
function mentions(text: string, term: string): boolean {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(term.toLowerCase())}(?:[^a-z0-9]|$)`).test(text);
}

/**
 * Reads the make from a title.
 *
 * Two rules, both learned from wrong output:
 *
 * Full make names are tested BEFORE aliases. An alias is an abbreviation, and
 * an abbreviation must never beat the real name of a different marque.
 *
 * Matching is whole-word. `includes('merc')` matched "Mercury", so every
 * Mercury in the index was filed as a Mercedes-Benz, and a 1968 Mercury Cougar
 * came back in a search for G-Wagens.
 */
export function parseMake(title: string): string | null {
  const t = title.toLowerCase();

  // Longest first so "Land Rover" wins over a bare token and "Austin-Healey"
  // is not shadowed by "Austin".
  const sorted = [...MAKES].sort((a, b) => b.length - a.length);
  for (const make of sorted) {
    if (mentions(t, make)) return make;
  }

  const aliases = Object.entries(MAKE_ALIASES).sort((a, b) => b[0].length - a[0].length);
  for (const [alias, make] of aliases) {
    if (mentions(t, alias)) return make;
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
  const makeLower = make?.toLowerCase() ?? null;

  /**
   * Everything up to and including the model year is dropped BEFORE either
   * lookup, not just before the fallback.
   *
   * The catalogue path used to search the raw title, which was survivable while
   * the vocabulary was a 47-make seed and became wrong the moment it held the
   * full vPIC catalogue: "Vantage-Specification 1974 Aston Martin V8 Series 3"
   * matched the real Aston Martin model "Vantage" in the seller's preamble and
   * returned it instead of the V8 that car actually is. The story an enthusiast
   * site puts in front of the year is not part of the vehicle's identity.
   */
  const yearAt = title.match(/\b(19|20)\d{2}(?:\.\d)?\b/);
  const stripped = yearAt
    ? title.slice(yearAt.index! + yearAt[0].length).trim()
    : title.replace(/^\s*(19|20)\d{2}\s+/, '');
  const text = stripped.toLowerCase();

  if (makeLower) {
    const catalogue = loadVocabulary().models[makeLower] ?? [];
    // Longest first, so "Land Cruiser" is not read as "Land" and "911 Turbo"
    // does not lose to "911".
    const hit = [...catalogue]
      .sort((a, b) => b.length - a.length)
      .find((m) => new RegExp(`\\b${m.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
    if (hit) return hit;
  }

  /** Fall back to the word after the make, in the same post-year remainder. */
  const afterMake = makeLower && stripped.toLowerCase().startsWith(makeLower)
    ? stripped.slice(makeLower.length).trim()
    : stripped;
  const token = afterMake.split(/[\s,/]+/).find((w) => w.length > 0 && w.toLowerCase() !== makeLower);
  if (!token) return null;

  // "Base", "AWD" and the like are trim noise, not a model.
  if (/^(base|awd|rwd|4wd|fwd|coupe|sedan|suv|convertible|cabriolet|spider|spyder|roadster|wagon|used|new)$/i.test(token)) {
    return null;
  }
  /**
   * An English connective is never a model.
   *
   * This fallback assumes everything after the year is the car, which holds for
   * "2020 Porsche Taycan" and breaks for a title that puts the model FIRST:
   * PakWheels writes "Porsche Taycan 2020 for sale in Lahore", so the remainder
   * is "for sale in Lahore" and every one of its listings was stored with the
   * model "For". Refusing the word is the narrow fix; the general one is that a
   * source with a known title shape should clean it before parsing, which is
   * what the marketplace adapter's own title hook is for.
   */
  if (/^(for|sale|in|at|with|and|or|the|a|an|by|from|on|of|to)$/i.test(token)) {
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
/**
 * One spelling per make.
 *
 * `canonicalModel` has existed since the 147-Ferrari incident, but the MAKE was
 * never run through anything: whatever spelling a source wrote went straight to
 * the column. Copart shouts (`PORSCHE`), most sites title-case (`Porsche`), and
 * a few lowercase it, so one marque arrived as three facet values holding 2153,
 * 182 and 5 cars. To a reader that looks like one make; to a filter it is three,
 * and picking the obvious one silently discards the other 187 cars.
 *
 * Unlike `parseMake` this never reads a title. It takes a make a source already
 * stated and fixes only its spelling, and an unrecognised marque is returned
 * trimmed rather than dropped: a make we have no entry for is still the truth
 * about that car.
 */
const MAKE_BY_KEY = new Map<string, string>([
  ...MAKES.map((m) => [m.toLowerCase().replace(/[^a-z0-9]/g, ''), m] as const),
  ...Object.entries(MAKE_ALIASES).map(([a, m]) => [a.toLowerCase().replace(/[^a-z0-9]/g, ''), m] as const),
]);

export function canonicalMake(make: string | null): string | null {
  const m = make?.trim();
  if (!m) return null;
  return MAKE_BY_KEY.get(m.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? m;
}

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

/**
 * Whether a mileage is a display rounding rather than a reading off a dial.
 *
 * This used to be a hand-written set, and the set had holes: it listed 25,000
 * and 50,000 but not 30,000, 40,000 or 60,000. That was survivable while the
 * composite dedupe key also demanded the prices agree, and stopped being so the
 * moment the key rested on mileage alone, because two different cars both
 * advertised at "40,000 miles" would have merged into one.
 *
 * So it is a rule, not a list: any exact multiple of a thousand is treated as
 * advertised rather than measured. That does misjudge the one real odometer in
 * a thousand that lands on a round number, and the cost is only that the car
 * falls through to the coarser key instead of the strong one. Being wrong in
 * that direction loses a merge; being wrong in the other direction fuses two
 * strangers' cars into a single listing.
 */
export function isRoundedMileage(miles: number | null): boolean {
  if (miles === null) return false;
  if (ROUND_MILEAGE.has(miles)) return true;
  return miles > 0 && miles % 1000 === 0;
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
    const make = canonicalMake(l.make);
    const model = canonicalModel(resolveModel(l.title, make, l.model));
    /**
     * Trim is resolved here, beside the model, because the peer groups built
     * below are only as honest as the definition of a peer. A 2016 Cayman GT4
     * and a base 2016 Cayman are not peers, and merging them puts the cohort's
     * lower quartile in the middle of the expensive cluster.
     */
    const trim = resolveTrim(l.title, make, model, l.trim);
    const bodyType = canonicalBodyType(l.bodyType);
    const fuelType = canonicalFuelType(l.fuelType);
    const exteriorColor = canonicalColor(l.exteriorColor);
    const interiorColor = canonicalColor(l.interiorColor);

    if (
      make === l.make && model === l.model && bodyType === l.bodyType && fuelType === l.fuelType &&
      exteriorColor === l.exteriorColor && interiorColor === l.interiorColor &&
      blankToNull(l.series) === l.series && trim === l.trim
    ) {
      return l;
    }

    return {
      ...l,
      make,
      model,
      series: blankToNull(l.series),
      trim,
      bodyType,
      fuelType,
      exteriorColor,
      interiorColor,
      /**
       * The seller's own words for the paint are kept. "Uyuni White" is worth
       * showing a buyer and useless to filter on, so the facet gets the family
       * and the record keeps the name.
       */
      raw: exteriorColor !== l.exteriorColor || interiorColor !== l.interiorColor
        ? { ...(l.raw ?? {}), exteriorColorName: l.exteriorColor, interiorColorName: l.interiorColor }
        : l.raw,
    };
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
      : isFinancingBait(l.title, l.price, l.year) ? 'price is a down payment or monthly figure, not the car'
      : isImpossiblePriceForAge(l.title, l.price, l.year, l.titleStatus) ? 'price is impossible for a car this age and no damage is disclosed'
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
