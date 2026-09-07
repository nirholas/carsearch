import type { CarStore } from './store.js';
import { SqliteStore } from './sqlite-adapter.js';
import { PostgresStore } from './postgres.js';

/**
 * Picks a backend from the environment.
 *
 * DATABASE_URL wins when it is set, which means production is Postgres by
 * configuration rather than by a build flag, and a developer with no database
 * running still gets a working aggregator from the SQLite file.
 */
export async function openStore(opts: { url?: string; sqlitePath?: string } = {}): Promise<CarStore> {
  const url = opts.url ?? process.env.DATABASE_URL;
  const store: CarStore = url ? new PostgresStore(url) : new SqliteStore(opts.sqlitePath ?? 'data/carsearch.db');
  await store.init();
  return store;
}

export { SqliteStore, PostgresStore };
export type { CarStore };
