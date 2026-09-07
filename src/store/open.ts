import type { CarStore } from './store.js';
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
  if (url) {
    const store = new PostgresStore(url);
    await store.init();
    return store;
  }

  /**
   * SQLite is imported dynamically so it is never loaded in production.
   *
   * better-sqlite3 is a native module, and the production image has no compiler
   * in it. A static import would make the module graph require a binary the
   * image cannot build, which fails at `npm ci` rather than at runtime and is
   * therefore invisible until someone actually builds the container. Postgres
   * is pure JavaScript, so the deployed image compiles nothing at all.
   */
  const { SqliteStore } = await import('./sqlite-adapter.js');
  const store = new SqliteStore(opts.sqlitePath ?? 'data/carsearch.db');
  await store.init();
  return store;
}

export { PostgresStore };
export type { CarStore };
