/**
 * Every attribute a car can be filtered on, defined once.
 *
 * This registry is the single source of truth for the search form, the API's
 * query parsing, the database columns, the coverage report and the natural
 * language layer. Adding a facet here makes it filterable everywhere; there is
 * no second list to keep in step.
 *
 * The hard part of facet search is not the filtering, it is the honesty. A
 * source that never publishes owner count leaves that column null on every one
 * of its listings, and a naive "1 owner" filter silently deletes that entire
 * source from the results while looking like it merely narrowed them. So every
 * facet carries its coverage, the API reports how many rows were excluded for
 * being unknown rather than for failing the test, and the UI says so.
 */

export type FacetGroup = 'core' | 'history' | 'mechanical' | 'efficiency' | 'appearance' | 'seller';

export type FacetKind = 'enum' | 'number' | 'boolean' | 'text';

export interface FacetDef {
  /** camelCase name used in the API query string and on the Listing object. */
  key: string;
  /** snake_case database column. */
  column: string;
  label: string;
  group: FacetGroup;
  kind: FacetKind;
  /** Allowed values for an enum facet, in the order the UI should offer them. */
  values?: readonly string[];
  /** Shown under the control when the meaning is not obvious from the label. */
  hint?: string;
  /** Units suffix for a number facet. */
  unit?: string;
  /**
   * True when filtering on this facet should exclude unknowns by default. A
   * buyer who asks for a clean title does not want the ones whose title is
   * unrecorded; a buyer who asks for four doors probably still wants the ones
   * that did not publish a door count.
   */
  strict?: boolean;
}

/**
 * Title brands, in ascending order of severity.
 *
 * `unknown` is a real value here, not an absence. Most listings never state a
 * title status at all, and conflating "the site did not say" with "the site
 * said clean" is the single most expensive mistake this whole category makes.
 */
export const TITLE_STATUSES = [
  'clean', 'unknown', 'lien', 'bonded', 'hail', 'theft-recovery',
  'rebuilt', 'salvage', 'flood', 'lemon', 'junk', 'parts-only',
] as const;
export type TitleStatus = (typeof TITLE_STATUSES)[number];

/** Title brands a buyer of an ordinary car almost never wants. */
export const BRANDED_TITLES: readonly TitleStatus[] = [
  'rebuilt', 'salvage', 'flood', 'lemon', 'junk', 'parts-only', 'theft-recovery', 'hail',
];

export const TRANSMISSIONS = ['manual', 'automatic', 'dual-clutch', 'cvt', 'single-speed'] as const;
export type Transmission = (typeof TRANSMISSIONS)[number];

export const DRIVETRAINS = ['fwd', 'rwd', 'awd', '4wd'] as const;
export type Drivetrain = (typeof DRIVETRAINS)[number];

export const USAGE_HISTORY = ['personal', 'lease', 'fleet', 'rental', 'commercial', 'taxi', 'driver-education'] as const;
export type UsageHistory = (typeof USAGE_HISTORY)[number];

export const SELLER_TYPES = ['dealer', 'private', 'auction'] as const;

export const FACETS: readonly FacetDef[] = [
  // --- Core ---------------------------------------------------------------
  { key: 'make', column: 'make', label: 'Make', group: 'core', kind: 'text' },
  { key: 'model', column: 'model', label: 'Model', group: 'core', kind: 'text' },
  { key: 'trim', column: 'trim', label: 'Trim', group: 'core', kind: 'text' },
  { key: 'series', column: 'series', label: 'Generation', group: 'core', kind: 'text',
    hint: 'Factory platform code from the VIN, e.g. Type 95B. This is the axis that moves price, not the marketing trim.' },
  { key: 'year', column: 'year', label: 'Model year', group: 'core', kind: 'number' },
  { key: 'price', column: 'price', label: 'Price', group: 'core', kind: 'number', unit: '$' },
  { key: 'mileage', column: 'mileage', label: 'Mileage', group: 'core', kind: 'number', unit: 'mi' },
  { key: 'bodyType', column: 'body_type', label: 'Body style', group: 'core', kind: 'text' },

  // --- History ------------------------------------------------------------
  { key: 'titleStatus', column: 'title_status', label: 'Title status', group: 'history', kind: 'enum',
    values: TITLE_STATUSES, strict: true,
    hint: 'Most listings never state one. "Unknown" is shown as its own value rather than assumed clean.' },
  { key: 'owners', column: 'owners', label: 'Previous owners', group: 'history', kind: 'number', strict: true },
  { key: 'accidents', column: 'accidents', label: 'Reported accidents', group: 'history', kind: 'number', strict: true },
  { key: 'accidentFree', column: 'accident_free', label: 'No accidents reported', group: 'history', kind: 'boolean', strict: true },
  { key: 'serviceRecords', column: 'service_records', label: 'Service records available', group: 'history', kind: 'boolean', strict: true },
  { key: 'usage', column: 'usage_history', label: 'Prior use', group: 'history', kind: 'enum', values: USAGE_HISTORY, strict: true,
    hint: 'A rental or fleet car wears differently from a personal one at the same odometer reading.' },
  { key: 'isImport', column: 'is_import', label: 'Imported', group: 'history', kind: 'boolean' },
  { key: 'openRecall', column: 'open_recall', label: 'Open safety recall', group: 'history', kind: 'boolean',
    hint: 'From the NHTSA recall database for this year, make and model.' },

  // --- Mechanical ---------------------------------------------------------
  { key: 'transmission', column: 'transmission', label: 'Transmission', group: 'mechanical', kind: 'enum', values: TRANSMISSIONS },
  { key: 'drivetrain', column: 'drivetrain', label: 'Drivetrain', group: 'mechanical', kind: 'enum', values: DRIVETRAINS },
  { key: 'fuelType', column: 'fuel_type', label: 'Fuel', group: 'mechanical', kind: 'text' },
  { key: 'engine', column: 'engine', label: 'Engine', group: 'mechanical', kind: 'text' },
  { key: 'cylinders', column: 'cylinders', label: 'Cylinders', group: 'mechanical', kind: 'number' },
  { key: 'displacementL', column: 'displacement_l', label: 'Displacement', group: 'mechanical', kind: 'number', unit: 'L' },
  { key: 'doors', column: 'doors', label: 'Doors', group: 'mechanical', kind: 'number' },
  { key: 'seats', column: 'seats', label: 'Seats', group: 'mechanical', kind: 'number' },

  // --- Efficiency ---------------------------------------------------------
  { key: 'mpgCity', column: 'mpg_city', label: 'MPG city', group: 'efficiency', kind: 'number', unit: 'mpg' },
  { key: 'mpgHighway', column: 'mpg_highway', label: 'MPG highway', group: 'efficiency', kind: 'number', unit: 'mpg' },
  { key: 'rangeMiles', column: 'range_miles', label: 'Electric range', group: 'efficiency', kind: 'number', unit: 'mi' },
  { key: 'batteryKwh', column: 'battery_kwh', label: 'Battery', group: 'efficiency', kind: 'number', unit: 'kWh' },

  // --- Appearance ---------------------------------------------------------
  { key: 'exteriorColor', column: 'exterior_color', label: 'Exterior colour', group: 'appearance', kind: 'text' },
  { key: 'interiorColor', column: 'interior_color', label: 'Interior colour', group: 'appearance', kind: 'text' },

  // --- Seller -------------------------------------------------------------
  { key: 'sellerType', column: 'seller_type', label: 'Seller', group: 'seller', kind: 'enum', values: SELLER_TYPES },
  { key: 'certified', column: 'certified', label: 'Manufacturer certified', group: 'seller', kind: 'boolean', strict: true },
  { key: 'dealerName', column: 'dealer_name', label: 'Dealer', group: 'seller', kind: 'text' },
  { key: 'dealerRating', column: 'dealer_rating', label: 'Dealer rating', group: 'seller', kind: 'number', unit: '/5' },
  { key: 'location', column: 'location', label: 'Location', group: 'seller', kind: 'text' },
];

export const FACETS_BY_KEY = new Map(FACETS.map((f) => [f.key, f]));

export const GROUP_LABELS: Record<FacetGroup, string> = {
  core: 'The car',
  history: 'Title and history',
  mechanical: 'Mechanical',
  efficiency: 'Efficiency',
  appearance: 'Colour',
  seller: 'Seller',
};

/* ------------------------------------------------------------------ parsing */

/**
 * Reads a title status out of free text.
 *
 * Order matters: "rebuilt salvage title" is a rebuilt title, and testing for
 * "salvage" first would brand it more harshly than the seller did. The most
 * specific phrasing is tested first throughout.
 */
export function parseTitleStatus(text: string | null | undefined): TitleStatus | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(parts?[\s-]?only|for parts)\b/.test(t)) return 'parts-only';
  if (/\b(junk|non[\s-]?repairable|certificate of destruction)\b/.test(t)) return 'junk';
  if (/\b(flood|water damage)\b/.test(t)) return 'flood';
  if (/\b(lemon|manufacturer buy ?back)\b/.test(t)) return 'lemon';
  if (/\b(rebuilt|reconstructed|revived|restored salvage|prior salvage)\b/.test(t)) return 'rebuilt';
  if (/\bsalvage\b/.test(t)) return 'salvage';
  if (/\btheft[\s-]?recover|recovered theft\b/.test(t)) return 'theft-recovery';
  if (/\bhail\b/.test(t)) return 'hail';
  if (/\bbonded\b/.test(t)) return 'bonded';
  if (/\b(lien|loan outstanding)\b/.test(t)) return 'lien';
  if (/\b(clean|clear)\s*(title|carfax)?\b/.test(t) || /\btitle in hand\b/.test(t)) return 'clean';
  return null;
}

export function parseTransmission(text: string | null | undefined): Transmission | null {
  if (!text) return null;
  const t = text.toLowerCase();
  /**
   * "Automated Manual Transmission (AMT)" is how NHTSA describes a PDK, a DSG
   * and every other clutchless two-pedal gearbox. Testing for "manual" before
   * this line labelled 34 automatic Macans as manuals, which is precisely the
   * kind of plausible wrong answer that sends a buyer who wants three pedals to
   * look at a car that has two.
   */
  if (/\b(automated[\s-]?manual|amt|automated manual transmission)\b/.test(t)) return 'dual-clutch';
  if (/\b(pdk|dct|dsg|dual[\s-]?clutch|s[\s-]?tronic|doppelkupplung)\b/.test(t)) return 'dual-clutch';
  // The alternation here needed its own group: `\bcvt|continuously variable\b`
  // binds as (\bcvt) or (continuously variable\b), which is not what it reads as.
  // "Automatic (variable gear ratios)" is vPIC's other spelling of a CVT.
  if (/\b(cvt|continuously[\s-]?variable|variable gear ratios)\b/.test(t)) return 'cvt';
  if (/\b(single[\s-]?speed|1[\s-]?speed|reduction gear)\b/.test(t)) return 'single-speed';
  if (/\b(manual|stick|\d[\s-]?speed manual|mt)\b/.test(t)) return 'manual';
  if (/\b(automatic|auto|tiptronic|steptronic|a\/t)\b/.test(t)) return 'automatic';
  return null;
}

export function parseDrivetrain(text: string | null | undefined): Drivetrain | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(4wd|4x4|four[\s-]?wheel[\s-]?drive|part[\s-]?time 4)\b/.test(t)) return '4wd';
  if (/\b(awd|all[\s-]?wheel[\s-]?drive|quattro|4matic|xdrive|4motion|sh[\s-]?awd)\b/.test(t)) return 'awd';
  if (/\b(rwd|rear[\s-]?wheel[\s-]?drive)\b/.test(t)) return 'rwd';
  if (/\b(fwd|front[\s-]?wheel[\s-]?drive)\b/.test(t)) return 'fwd';
  return null;
}

export function parseUsage(text: string | null | undefined): UsageHistory | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(taxi|ride[\s-]?share|uber|lyft)\b/.test(t)) return 'taxi';
  if (/\b(driver ?(?:s)? ?(?:ed|education)|driving school)\b/.test(t)) return 'driver-education';
  if (/\b(rental|rent[\s-]?a[\s-]?car|hertz|avis|enterprise fleet)\b/.test(t)) return 'rental';
  if (/\b(fleet|corporate|government|municipal)\b/.test(t)) return 'fleet';
  if (/\b(commercial|delivery|work truck)\b/.test(t)) return 'commercial';
  if (/\b(lease|leased|off[\s-]?lease)\b/.test(t)) return 'lease';
  if (/\b(personal|private use|one family)\b/.test(t)) return 'personal';
  return null;
}

/** "1 Owner", "2 owners", "one-owner car". */
export function parseOwners(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(one|single|1)[\s-]?owner\b/.test(t)) return 1;
  const m = t.match(/\b(\d{1,2})\s*(?:previous\s*)?owners?\b/);
  if (m?.[1]) {
    const n = Number(m[1]);
    return n > 0 && n < 30 ? n : null;
  }
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
  const w = t.match(/\b(two|three|four|five)[\s-]?owners?\b/);
  if (w?.[1]) return words[w[1]] ?? null;
  return null;
}

/**
 * Accident count from free text.
 *
 * "No accidents reported" is 0 accidents REPORTED, which is not the same as no
 * accidents. The field name says `accidents` and the UI label says "reported",
 * because a report is all any of these sources actually knows.
 */
export function parseAccidents(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\b(no|zero|0)\s+(?:reported\s+)?accidents?\b/.test(t)) return 0;
  if (/\baccident[\s-]?free\b/.test(t)) return 0;
  const m = t.match(/\b(\d{1,2})\s+(?:reported\s+)?accidents?\b/);
  if (m?.[1]) return Number(m[1]);
  if (/\b(one|1)\s+accident\b/.test(t)) return 1;
  return null;
}
