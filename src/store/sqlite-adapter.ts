import { Store } from './db.js';
import type { CarStore, SearchFilters, SoldComps, StoreStats, FacetCoverage } from './store.js';
import type { Listing, RejectedListing } from '../core/types.js';
import type { DedupeGroup } from '../core/dedupe.js';

/**
 * Presents the synchronous SQLite store through the async contract.
 *
 * Deliberately a thin wrapper rather than a rewrite: the SQLite implementation
 * is well tested and the CLI still uses it directly, so wrapping costs one
 * promise per call and risks nothing.
 */
export class SqliteStore implements CarStore {
  readonly kind = 'sqlite';
  private db: Store;

  constructor(path = 'data/carsearch.db') {
    this.db = new Store(path);
  }

  async init(): Promise<void> {
    /* the schema is applied by the underlying store's constructor */
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async upsertMany(listings: Listing[]) {
    return this.db.upsertMany(listings);
  }

  async recordRejects(rejects: RejectedListing[]): Promise<void> {
    this.db.recordRejects(rejects);
  }

  async saveGroups(groups: DedupeGroup[]): Promise<void> {
    this.db.saveGroups(groups);
  }

  async recordRun(sourceId: string, ok: boolean, listings: number, rejected: number, durationMs: number, error?: string): Promise<void> {
    this.db.recordRun(sourceId, ok, listings, rejected, durationMs, error);
  }

  async markDelisted(sourceId: string, seenIds: string[]): Promise<number> {
    return this.db.markDelisted(sourceId, seenIds);
  }

  async facetCoverage(f?: SearchFilters): Promise<FacetCoverage[]> { return this.db.facetCoverage(f); }

  async search(filters: SearchFilters = {}): Promise<Listing[]> {
    return this.db.search(filters);
  }

  async soldComps(make: string, model: string, yearMin: number, yearMax: number): Promise<SoldComps> {
    return this.db.soldComps(make, model, yearMin, yearMax);
  }

  async soldPricesFor(make: string | null, model: string | null, year: number | null, yearWindow = 2): Promise<number[]> {
    return this.db.soldPricesFor(make, model, year, yearWindow);
  }

  async priceHistory(listingId: string) {
    return this.db.priceHistory(listingId);
  }

  async daysOnMarket(listingId: string): Promise<number | null> {
    return this.db.daysOnMarket(listingId);
  }

  async cacheVinDecode(vin: string, decoded: unknown): Promise<void> {
    this.db.cacheVinDecode(vin, decoded);
  }

  async getVinDecode<T>(vin: string): Promise<T | null> {
    return this.db.getVinDecode<T>(vin);
  }

  async stats(): Promise<StoreStats> {
    return this.db.stats();
  }
}
