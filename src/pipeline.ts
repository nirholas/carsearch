import pLimit from 'p-limit';
import type { Listing, SearchQuery, SourceAdapter, AdapterContext } from './core/types.js';
import { validate, checkDistinctPrices } from './core/normalize.js';
import { dedupe, dedupeStats, type DedupeGroup } from './core/dedupe.js';
import { enrichAll } from './enrich/vpic.js';
import { fetchText } from './transport/fetcher.js';
import { evaluateInPage, closeBrowser } from './transport/browser.js';
import { ADAPTERS } from './sources/index.js';
import type { CarStore } from './store/store.js';

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
  /**
   * How many sources to crawl at once. Sources are independent hosts and the
   * throttle in the transport layer is already per host, so running them in
   * parallel does not make us any less polite to any individual site: it only
   * stops a slow one holding up the rest.
   *
   * Bounded rather than unlimited because every browser-backed adapter holds a
   * Chromium page, and an unbounded fan-out would exhaust memory on a small
   * container long before it saturated the network.
   */
  concurrency?: number;
  store?: CarStore;
  sourceIds?: string[];
  enrich?: boolean;
  onLog?: (msg: string) => void;
}

/**
 * Four at a time. Each browser-backed adapter holds a Chromium page, and the
 * Cloud Run crawler job is provisioned with 4GB, which comfortably fits four
 * concurrent pages and does not fit a dozen.
 */
const DEFAULT_CONCURRENCY = 4;

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
  const limit = pLimit(Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY));

  /**
   * One source failing must never abort the others. Each task resolves rather
   * than rejects, so a blocked site costs its own results and nothing else:
   * a crawl that returns four sources out of five is worth far more than one
   * that returns nothing because the fifth was down.
   */
  await Promise.all(
    adapters.map((adapter) =>
      limit(async () => {
        const t0 = Date.now();
        try {
          const rows = await adapter.search(opts.query, ctx);
          collected.push(...rows);
          log(`  ${adapter.source.id}: returned ${rows.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          await opts.store?.recordRun(adapter.source.id, true, rows.length, 0, Date.now() - t0);
        } catch (e) {
          const msg = (e as Error).message.split('\n')[0] ?? 'unknown';
          log(`  ${adapter.source.id} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${msg}`);
          failed.push(adapter.source.id);
          await opts.store?.recordRun(adapter.source.id, false, 0, 0, Date.now() - t0, msg);
        }
      }),
    ),
  );

  if (process.env.CARSEARCH_TRACE) log(`  [trace] crawl finished at ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const enriched = opts.enrich === false ? collected : await enrichAll(collected, opts.store);
  if (process.env.CARSEARCH_TRACE) log(`  [trace] enrich finished at ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const { kept, rejected } = validate(enriched);
  const integrity = checkDistinctPrices(kept);
  if (!integrity.ok) log(`WARNING ${integrity.message}`);

  const groups = dedupe(kept);

  if (opts.store) {
    const w = await opts.store.upsertMany(kept);
    log(`  store: wrote ${JSON.stringify(w)} from ${kept.length} kept`);
    await opts.store.recordRejects(rejected);
    await opts.store.saveGroups(groups);
  }

  const bySource: Record<string, number> = {};
  for (const l of kept) bySource[l.sourceId] = (bySource[l.sourceId] ?? 0) + 1;
  const rejectReasons: Record<string, number> = {};
  for (const r of rejected) rejectReasons[r.why] = (rejectReasons[r.why] ?? 0) + 1;

  if (process.env.CARSEARCH_TRACE) log(`  [trace] pipeline returning at ${((Date.now() - started) / 1000).toFixed(1)}s`);
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
