import type { Listing, RejectedListing, PriceKind } from '../core/types.js';
import type { DedupeGroup } from '../core/dedupe.js';

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
  sort?: 'price' | 'mileage' | 'year' | 'newest' | 'days-on-market';
  limit?: number;
  offset?: number;
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
  soldComps(make: string, model: string, yearMin: number, yearMax: number): Promise<SoldComps>;
  soldPricesFor(make: string | null, model: string | null, year: number | null, yearWindow?: number): Promise<number[]>;
  priceHistory(listingId: string): Promise<{ observedAt: string; price: number }[]>;
  daysOnMarket(listingId: string): Promise<number | null>;

  cacheVinDecode(vin: string, decoded: unknown): Promise<void>;
  getVinDecode<T>(vin: string): Promise<T | null>;

  stats(): Promise<StoreStats>;
}
