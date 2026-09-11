import { readFileSync } from 'node:fs';
import { dedupe } from '../src/core/dedupe.js';
import { SOURCES } from '../src/sources/registry.js';
import type { Listing } from '../src/core/types.js';

/**
 * Ranks the output of live-search.ts into the answer a buyer actually wants.
 *
 * live-search.ts reports what each source returned, which is a crawl log, not a
 * shortlist: the same car appears on four sites at four prices and a branded
 * title sits in one copy of it. This puts the rows through the real dedupe so a
 * group speaks with the worst history any member states, and prints the range
 * between the cheapest and dearest listing of each car, because an aggregator's
 * markup is not a different car and a buyer should see both numbers.
 *
 * Usage:
 *   npx tsx scripts/rank-results.ts <file.json> [--model i8] [--limit 25]
 */

/**
 * Positional file arguments only.
 *
 * Filtering on a leading `--` is not enough: it keeps the VALUE of every flag,
 * so `--model i8` left "i8" in the file list and the run died trying to open a
 * file named after the car.
 */
const VALUED_FLAGS = new Set(['--model', '--limit', '--currency', '--year-min', '--year-max', '--mileage-max', '--price-max', '--price-kind']);
const files: string[] = [];
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]!;
  if (VALUED_FLAGS.has(arg)) { i += 1; continue; }
  if (arg.startsWith('--')) continue;
  files.push(arg);
}
if (files.length === 0) throw new Error('usage: rank-results.ts <file.json> [--model <name>] [--limit <n>]');

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const wantedModel = flag('model');
const limit = Number(flag('limit') ?? 25);
/**
 * Currencies are never converted, so a mixed list is not a ranking.
 *
 * A GBP 22,500 car sorts above a USD 36,792 one and is not cheaper, and a buyer
 * in one country cannot drive the other home. Filtering is the honest way to
 * compare; converting would bake today's rate into a stored record.
 */
const wantedCurrency = flag('currency')?.toUpperCase();

/**
 * The crawl's own year and mileage arguments are hints to each SOURCE, not a
 * filter over the result. Several sites ignore them, and a source with no such
 * parameter at all returns its whole catalogue, so a "2019 and newer, under
 * 60,000 miles" crawl comes back with 200,000-mile salvage lots in it. The
 * constraints have to be applied here as well, to the rows.
 */
const yearMin = flag('year-min') ? Number(flag('year-min')) : undefined;
const yearMax = flag('year-max') ? Number(flag('year-max')) : undefined;
const mileageMax = flag('mileage-max') ? Number(flag('mileage-max')) : undefined;
const priceMax = flag('price-max') ? Number(flag('price-max')) : undefined;
const priceKind = flag('price-kind');

/**
 * A row satisfies a constraint only by stating a value that meets it.
 *
 * An unknown mileage is not "under 60,000 miles", and treating it as passing is
 * how a Copart lot with no odometer reading reaches the top of a low-mileage
 * search. Silence fails a filter the caller explicitly asked for.
 */
function withinLimits(l: Listing): boolean {
  if (priceKind && l.priceKind !== priceKind) return false;
  if (yearMin !== undefined && (l.year === null || l.year < yearMin)) return false;
  if (yearMax !== undefined && (l.year === null || l.year > yearMax)) return false;
  if (mileageMax !== undefined && (l.mileage === null || l.mileage > mileageMax)) return false;
  if (priceMax !== undefined && (l.price === null || l.price > priceMax)) return false;
  return true;
}

const NAME = new Map(SOURCES.map((s) => [s.id, s.name]));
const rows: Listing[] = files.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as Listing[]);
const groups = dedupe(rows);

const tokens = (v: string) => new Set(v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
function isModel(l: Listing): boolean {
  if (!wantedModel) return true;
  const x = tokens(l.model ?? '');
  const y = tokens(wantedModel);
  if (x.size === 0) return false;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

const ranked = groups
  .filter((g) => g.primary.price !== null && isModel(g.primary))
  .filter((g) => !wantedCurrency || (g.primary.currency ?? 'USD').toUpperCase() === wantedCurrency)
  .filter((g) => withinLimits(g.primary))
  .sort((a, b) => low(a.members) - low(b.members));

function low(members: Listing[]): number {
  return Math.min(...members.map((m) => m.price ?? Infinity));
}

/** Every history flag any member of the group published, deduplicated. */
function flags(members: Listing[]): string[] {
  return [...new Set(members.flatMap((m) => ((m.raw as { vhrPreview?: string[] } | null)?.vhrPreview) ?? []))];
}

/**
 * What to tell a buyer about the car's history, in one phrase.
 *
 * A stated brand outranks everything, then a reported accident, then a clean
 * report, and silence is reported as silence. Nothing here infers a clean title
 * from the absence of a bad one.
 */
function verdict(g: { primary: Listing; members: Listing[] }): string {
  const f = flags(g.members);
  if (g.primary.titleStatus && g.primary.titleStatus !== 'clean' && g.primary.titleStatus !== 'unknown') {
    return `!! ${g.primary.titleStatus.toUpperCase()} TITLE`;
  }
  if (f.includes('FRAME_DAMAGE')) return '!! frame damage';
  if (g.primary.accidentFree === false) return '!! accident reported';
  if (f.includes('NO_SALVAGE_TITLE') && g.primary.accidentFree === true) {
    return `salvage-free, no accidents${g.primary.owners === 1 ? ', 1-owner' : ''}`;
  }
  if (g.primary.accidentFree === true) return 'no accidents reported';
  return 'history not published';
}

console.log(`${rows.length} rows, ${groups.length} unique vehicles, ${ranked.length} matching\n`);
for (const [i, g] of ranked.slice(0, limit).entries()) {
  const p = g.primary;
  const prices = g.members.map((m) => m.price).filter((v): v is number => v !== null);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const cur = p.currency ?? 'USD';
  // The advertised price and the aggregator's marked-up one are the same car.
  const span = lo === hi ? `${cur} ${lo.toLocaleString()}` : `${cur} ${lo.toLocaleString()}-${hi.toLocaleString()}`;
  const fair = g.members
    .map((m) => (m.raw as { kbbFairPurchasePrice?: number } | null)?.kbbFairPurchasePrice)
    .find((v): v is number => typeof v === 'number');
  const under = fair && fair > lo ? ` [$${(fair - lo).toLocaleString()} under KBB fair]` : '';
  const miles = p.mileage === null ? 'miles n/a' : `${p.mileage.toLocaleString()}mi`;
  const where = g.sources.map((s) => NAME.get(s) ?? s).join('+');
  console.log(`${String(i + 1).padStart(3)}. ${span} | ${p.year ?? '????'} | ${miles} | ${verdict(g)}${under}`);
  console.log(`     ${where} | ${p.location ?? 'location not stated'} | ${p.url ?? 'no link'}`);
}
