/**
 * Core domain model.
 *
 * The single most important distinction in this file is `priceKind`. An asking
 * price, a live auction bid, and a completed sale are three different
 * quantities, and averaging across them produces a number that means nothing.
 * Every incumbent aggregator shows asks only. Keeping the three separate, and
 * being able to show a buyer what cars like this actually sold for, is the
 * reason this project exists.
 */

/** What a price on a listing actually represents. */
export type PriceKind =
  /** A seller's asking price. Negotiable, and usually above the transaction price. */
  | 'ask'
  /** The current high bid on a live auction. Not a price anyone has paid. */
  | 'bid'
  /** A completed transaction. The only kind that belongs in a comparables calculation. */
  | 'sold';

/** How a source's data is obtained, which determines its maintenance cost and reliability. */
export type AccessMethod =
  /** A documented API returning structured data. Stable, preferred. */
  | 'api'
  /** A JSON endpoint the site's own frontend calls. Stable enough, undocumented. */
  | 'feed'
  /** Structured data embedded in the page (JSON-LD, microdata). Stable and rich. */
  | 'jsonld'
  /** Parsed from rendered HTML. Breaks when the site redesigns. */
  | 'html';

/** Which transport can actually reach a source. Empirically determined, never assumed. */
export type Transport =
  /** A plain HTTP request works. Cheap and fast. */
  | 'fetch'
  /** A real browser is required. Expensive but defeats most bot defenses. */
  | 'browser'
  /** Either works. Prefer fetch. */
  | 'either'
  /** Neither works today. */
  | 'blocked';

export type SourceCategory =
  | 'aggregator'
  | 'marketplace'
  | 'retailer'
  | 'classified'
  | 'auction-enthusiast'
  | 'auction-wholesale'
  | 'auction-salvage'
  | 'auction-government'
  | 'oem'
  | 'dealer-group'
  | 'specialty'
  | 'ev'
  | 'data-api';

export type SourceStatus =
  /** Adapter implemented and verified working. */
  | 'live'
  /** Reachable and worth building, adapter not written yet. */
  | 'planned'
  /** Reachable only through an aggregator that carries it. */
  | 'via-aggregator'
  /** Defenses defeat us today. Recorded so we stop re-testing blindly. */
  | 'blocked'
  /** Needs credentials or a paid plan we do not have. */
  | 'needs-credentials';

/** A place cars are listed. The registry of these is the spine of the project. */
export interface Source {
  /** Stable short id used in listing records and the database. Never change one. */
  id: string;
  name: string;
  homepage: string;
  category: SourceCategory;
  /** ISO 3166-1 alpha-2 codes, or 'GLOBAL'. */
  countries: string[];
  status: SourceStatus;
  transport: Transport;
  access: AccessMethod;
  /** What kind of price this source publishes. Some publish more than one. */
  priceKinds: PriceKind[];
  /**
   * If this source is only reachable through an aggregator, the aggregator's id
   * and the code that aggregator uses to label it.
   */
  reachableVia?: { sourceId: string; code: string };
  /** Free-text operational knowledge. Read before writing an adapter. */
  notes?: string;
}

/** A vehicle offered for sale, normalized across every source. */
export interface Listing {
  /** Deterministic id: `${sourceId}:${sourceListingId}`. Stable across runs. */
  id: string;
  sourceId: string;
  /** The source's own id for this listing, when it exposes one. */
  sourceListingId: string | null;
  url: string | null;

  title: string;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  /** Factory platform or series code, e.g. "Type 95B". From VIN decode, not from the listing. */
  series: string | null;

  vin: string | null;
  price: number | null;
  priceKind: PriceKind;
  currency: string;
  mileage: number | null;
  /**
   * True when the mileage looks like a display rounding rather than an odometer
   * reading (exactly 1000, 3000, and similar). Do not treat as exact.
   */
  mileageIsRounded: boolean;

  location: string | null;
  sellerType: 'dealer' | 'private' | 'auction' | null;
  bodyType: string | null;
  exteriorColor: string | null;
  fuelType: string | null;

  /** For auctions: when bidding ends. For sold records: when it sold. */
  eventDate: string | null;
  imageUrl: string | null;

  /** When we first and last observed this listing. Drives days-on-market. */
  firstSeen: string;
  lastSeen: string;

  /** Anything source-specific that does not fit the model, kept rather than discarded. */
  raw?: Record<string, unknown>;
}

/** A listing that failed validation, kept with the reason so parser rot is visible. */
export interface RejectedListing extends Partial<Listing> {
  why: string;
  sourceId: string;
  title?: string;
}

/** One observation of a listing's price at a point in time. Cannot be backfilled. */
export interface PricePoint {
  listingId: string;
  observedAt: string;
  price: number;
}

/** A normalized search request, independent of any source's query syntax. */
export interface SearchQuery {
  make?: string;
  /** Multiple models are queried separately: per-model queries return far more than one broad query. */
  models?: string[];
  yearMin?: number;
  yearMax?: number;
  priceMin?: number;
  priceMax?: number;
  mileageMax?: number;
  zip?: string;
  /** Miles, or 'any' for nationwide. */
  radius?: number | 'any';
  bodyType?: string;
  fuelType?: string;
  /** Free text, used by sources that support it and by the natural-language layer. */
  keywords?: string;
  /** Restrict to these source ids. Empty or absent means every live source. */
  sourceIds?: string[];
  priceKinds?: PriceKind[];
  limit?: number;
}

/** What every source adapter implements. */
export interface SourceAdapter {
  source: Source;
  /** Returns raw listings. Normalization, plausibility and dedupe happen downstream. */
  search(query: SearchQuery, ctx: AdapterContext): Promise<Listing[]>;
}

export interface AdapterContext {
  /** Two-transport fetcher. Use this rather than calling fetch or Playwright directly. */
  fetchText(url: string, opts?: { transport?: Transport; waitMs?: number }): Promise<string>;
  /** Runs a function inside a real browser page and returns its result. */
  evaluate<T>(url: string, fn: () => T, opts?: EvaluateOptions): Promise<T>;
  log(msg: string): void;
}

export interface EvaluateOptions {
  /** Wait this long after load before evaluating. */
  waitMs?: number;
  /**
   * Poll this selector's count until stable for `stableChecks` consecutive
   * checks. Results stream in per source asynchronously, so a fixed wait
   * truncates the slower ones.
   */
  settleSelector?: string;
  stableChecks?: number;
  maxPolls?: number;
  /** Click a "show more" style control repeatedly to page through results. */
  expandSelector?: string;
  maxExpands?: number;
  scroll?: boolean;
  timeoutMs?: number;
}
