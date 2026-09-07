import type { Listing, SearchQuery, SourceAdapter, AdapterContext } from './core/types.js';
import { validate, checkDistinctPrices } from './core/normalize.js';
import { dedupe, dedupeStats, type DedupeGroup } from './core/dedupe.js';
import { enrichAll } from './enrich/vpic.js';
import { fetchText } from './transport/fetcher.js';
import { evaluateInPage, closeBrowser } from './transport/browser.js';
import { ADAPTERS } from './sources/index.js';
import { Store } from './store/db.js';

/**
 * The ingestion pipeline.
 *
 * Order is deliberate: collect, then enrich, then validate, then dedupe, then
 * persist. Enrichment runs before validation because a VIN decode fills in the
 * make and model that plausibility checking groups on, and dedupe runs after
 * validation so a bad parse is never chosen as a group's primary record.
 */

export interface RunOptions {
  query: SearchQuery;
  store?: Store;
  sourceIds?: string[];
  enrich?: boolean;
  onLog?: (msg: string) => void;
}

export interface RunResult {
  listings: Listing[];
  groups: DedupeGroup[];
  rejected: { title?: string; why: string; sourceId: string }[];
  stats: {
    bySource: Record<string, number>;
    rejectReasons: Record<string, number>;
    dedupe: ReturnType<typeof dedupeStats>;
    priceIntegrity: string;
    durationMs: number;
    sourcesRun: number;
    sourcesFailed: string[];
  };
}

function makeContext(log: (m: string) => void): AdapterContext {
  return {
    fetchText: (url, opts) => fetchText(url, opts),
    evaluate: (url, fn, opts) => evaluateInPage(url, fn, opts),
    log,
  };
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const log = opts.onLog ?? ((m: string) => console.log(m));
  const ctx = makeContext(log);

  const adapters: SourceAdapter[] = opts.sourceIds?.length
    ? ADAPTERS.filter((a) => opts.sourceIds!.includes(a.source.id))
    : ADAPTERS;

  const collected: Listing[] = [];
  const failed: string[] = [];

  for (const adapter of adapters) {
    const t0 = Date.now();
    try {
      const rows = await adapter.search(opts.query, ctx);
      collected.push(...rows);
      log(`  ${adapter.source.id}: returned ${rows.length}, collected now ${collected.length}`);
      opts.store?.recordRun(adapter.source.id, true, rows.length, 0, Date.now() - t0);
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0] ?? 'unknown';
      log(`${adapter.source.id} FAILED: ${msg}`);
      failed.push(adapter.source.id);
      opts.store?.recordRun(adapter.source.id, false, 0, 0, Date.now() - t0, msg);
    }
  }

  const enriched = opts.enrich === false ? collected : await enrichAll(collected, opts.store);

  const { kept, rejected } = validate(enriched);
  const integrity = checkDistinctPrices(kept);
  if (!integrity.ok) log(`WARNING ${integrity.message}`);

  const groups = dedupe(kept);

  if (opts.store) {
    const w = opts.store.upsertMany(kept);
    log(`  store: wrote ${JSON.stringify(w)} from ${kept.length} kept`);
    opts.store.recordRejects(rejected);
    opts.store.saveGroups(groups);
  }

  const bySource: Record<string, number> = {};
  for (const l of kept) bySource[l.sourceId] = (bySource[l.sourceId] ?? 0) + 1;
  const rejectReasons: Record<string, number> = {};
  for (const r of rejected) rejectReasons[r.why] = (rejectReasons[r.why] ?? 0) + 1;

  return {
    listings: kept,
    groups,
    rejected: rejected.map((r) => ({ title: r.title, why: r.why, sourceId: r.sourceId })),
    stats: {
      bySource,
      rejectReasons,
      dedupe: dedupeStats(kept, groups),
      priceIntegrity: integrity.message,
      durationMs: Date.now() - started,
      sourcesRun: adapters.length,
      sourcesFailed: failed,
    },
  };
}

export { closeBrowser };
