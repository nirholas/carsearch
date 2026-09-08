import type { Listing, RejectedListing, PriceKind } from '../core/types.js';
import type { DedupeGroup } from '../core/dedupe.js';
import type { FacetFilter } from './filter.js';

/**
 * The storage contract, shared by the SQLite and PostgreSQL implementations.
 *
 * Every method is async even though SQLite answers synchronously. Postgres
 * cannot be synchronous, and a contract that is sync for one backend and async
 * for the other is not one contract. The SQLite adapter pays a trivial promise
 * wrapper so that callers are written once.
 *
 * Why two backends at all: SQLite means a full aggregator runs locally with
 * nothing to stand up, which keeps the development loop fast. Postgres is what
 * production needs, because price history is the one dataset that cannot be
 * backfilled and it must not live on a disk that disappears with the next
 * deploy.
 */

export interface SearchFilters {
  make?: string;
  model?: string;
  yearMin?: number;
  yearMax?: number;
  priceMin?: number;
  priceMax?: number;
  mileageMax?: number;
  priceKinds?: PriceKind[];
  sourceIds?: string[];
  bodyType?: string;
  fuelType?: string;
  text?: string;
  /**
   * Coarse pre-ordering for the candidate pool only.
   *
   * The real ordering is multi-criteria and computed in `core/rank.ts` over the
   * whole pool, because a percentile taken from a page that SQL already
   * truncated is a percentile of the wrong population. This exists so that
   * when the pool cap does bite, it discards the least relevant rows.
   */
  sort?: 'price' | 'mileage' | 'year' | 'newest' | 'days-on-market';
  /** Every other attribute, keyed by facet. See core/facets.ts. */
  facets?: Record<string, FacetFilter>;
  limit?: number;
  offset?: number;
}

/** How many listings actually publish each facet, and the values they use. */
export interface FacetCoverage {
  key: string;
  column: string;
  label: string;
  group: string;
  kind: string;
  unit?: string;
  hint?: string;
  strict: boolean;
  /** Rows in scope that carry a value for this facet. */
  known: number;
  /** Rows in scope, so the UI can render "412 of 2,118 say". */
  total: number;
  /** For enum and text facets: the distinct values, commonest first. */
  values?: { value: string; n: number }[];
  /** For number facets. */
  min?: number | null;
  max?: number | null;
}

export interface SoldComps {
  count: number;
  median: number | null;
  low: number | null;
  high: number | null;
  sales: {
    price: number;
    year: number;
    mileage: number | null;
    event_date: string | null;
    source_id: string;
    title: string;
    url: string | null;
  }[];
}

export interface StoreStats {
  listings: number;
  delisted: number;
  withVin: number;
  sold: number;
  pricePoints: number;
  rejects: number;
  bySource: { source_id: string; n: number }[];
  rejectReasons: { why: string; n: number }[];
}

export interface CarStore {
  init(): Promise<void>;
  close(): Promise<void>;

  upsertMany(listings: Listing[]): Promise<{ inserted: number; updated: number; priceChanges: number }>;
  recordRejects(rejects: RejectedListing[]): Promise<void>;
  saveGroups(groups: DedupeGroup[]): Promise<void>;
  recordRun(sourceId: string, ok: boolean, listings: number, rejected: number, durationMs: number, error?: string): Promise<void>;
  markDelisted(sourceId: string, seenIds: string[]): Promise<number>;

  search(filters?: SearchFilters): Promise<Listing[]>;
  /**
   * How many rows in a given scope publish each facet.
   *
   * The search form is built from this, so a control for an attribute nothing
   * in the index carries is shown with its real coverage rather than offered as
   * if it worked. A filter that would silently empty the page is the failure
   * mode this exists to prevent.
   */
  facetCoverage(filters?: SearchFilters): Promise<FacetCoverage[]>;
  soldComps(make: string, model: string, yearMin: number, yearMax: number): Promise<SoldComps>;
  soldPricesFor(make: string | null, model: string | null, year: number | null, yearWindow?: number): Promise<number[]>;
  priceHistory(listingId: string): Promise<{ observedAt: string; price: number }[]>;
  daysOnMarket(listingId: string): Promise<number | null>;

  cacheVinDecode(vin: string, decoded: unknown): Promise<void>;
  getVinDecode<T>(vin: string): Promise<T | null>;

  stats(): Promise<StoreStats>;
}
