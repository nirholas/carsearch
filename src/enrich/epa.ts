import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Listing } from '../core/types.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';

/**
 * EPA fuel economy data, from a free, keyless, documented government API.
 *
 * This is the cheapest facet coverage available anywhere. Fuel economy, engine
 * size, cylinder count, transmission type, drivetrain and electric range are
 * properties of a MODEL, not of a listing, so they can be looked up for any car
 * whose year, make and model are known. Almost every row qualifies, and no
 * listing site publishes most of them.
 *
 * Unlike every crawled source, this one cannot be blocked, cannot rate-limit us
 * into a challenge, and cannot change its markup. It is the sort of source that
 * should be exhausted before any scraper is written.
 *
 * Answers are cached to disk because the lookup is per (year, make, model)
 * cohort rather than per listing, and a second run over the same index should
 * cost nothing.
 */

const MENU = 'https://www.fueleconomy.gov/ws/rest/vehicle/menu';
const VEHICLE = 'https://www.fueleconomy.gov/ws/rest/vehicle';

export interface EpaFacts {
  mpgCity: number | null;
  mpgHighway: number | null;
  cylinders: number | null;
  displacementL: number | null;
  transmission: Listing['transmission'];
  drivetrain: Listing['drivetrain'];
  rangeMiles: number | null;
  fuelType: string | null;
}

interface MenuItem { text?: string; value?: string }
interface MenuResponse { menuItem?: MenuItem | MenuItem[] }

/** The API returns a bare object when there is exactly one item, an array otherwise. */
function items(res: MenuResponse): MenuItem[] {
  const m = res.menuItem;
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Words that mark a higher-performance variant.
 *
 * These matter because the figures differ sharply between them: a 911 Turbo
 * and a 911 Carrera are the same model to a listing and different cars to the
 * EPA.
 */
const PERFORMANCE_TRIM =
  /\b(turbo|gts|gt[0-9rs]?|rs|amg|type[\s-]?r|sport|s|srt|hellcat|raptor|trackhawk|nismo|shelby|cobra|z06|zr1|competition|performance|quadrifoglio|n[uü]rburgring)\b/i;

/**
 * Picks the EPA model name that matches ours.
 *
 * The catalogues disagree predictably: the EPA lists "911 Carrera",
 * "911 Carrera 4" and "911 Turbo" where a listing just says "911". When the
 * listing names no variant, the base one is the right default, and getting this
 * backwards attributes Turbo economy figures to every 911 in the index.
 *
 * Shortest-name was the first rule tried and it is wrong: "911 Turbo" is
 * shorter than "911 Carrera". The signal is not length, it is whether the extra
 * words name a performance variant.
 */
export function bestModelMatch(ours: string, theirs: string[]): string | null {
  const target = norm(ours);
  if (!target) return null;

  const exact = theirs.find((t) => norm(t) === target);
  if (exact) return exact;

  const score = (candidate: string): number => {
    const extra = candidate.slice(0).replace(new RegExp(ours, 'i'), '').trim();
    const extraWords = extra.split(/\s+/).filter(Boolean).length;
    // A performance qualifier outweighs any number of neutral extra words.
    return extraWords + (PERFORMANCE_TRIM.test(extra) ? 100 : 0);
  };

  const contains = theirs
    .filter((t) => norm(t).includes(target))
    // Alphabetical last, purely so the answer is deterministic across runs.
    .sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  if (contains.length) return contains[0]!;

  // Ours is more specific than anything they list: take their closest parent.
  const reverse = theirs.filter((t) => target.includes(norm(t))).sort((a, b) => b.length - a.length);
  return reverse[0] ?? null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

interface CacheFile { [key: string]: EpaFacts | null }

let cache: CacheFile | null = null;
let cachePath = 'data/epa-cache.json';
let dirty = false;

export function loadCache(path = cachePath): void {
  cachePath = path;
  try {
    cache = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
  } catch {
    cache = {};
  }
}

export function saveCache(): void {
  if (!cache || !dirty) return;
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));
  dirty = false;
}

/**
 * Facts for one year, make and model. Null when the EPA has no such vehicle,
 * which is normal: it covers cars sold in the US from 1984 and nothing else.
 */
export async function epaFacts(year: number | null, make: string | null, model: string | null): Promise<EpaFacts | null> {
  if (!year || !make || !model) return null;
  // The dataset starts in 1984 and does not include the coming model year.
  if (year < 1984 || year > new Date().getFullYear() + 1) return null;

  if (!cache) loadCache();
  const key = `${year}|${make.toLowerCase()}|${model.toLowerCase()}`;
  if (key in cache!) return cache![key] ?? null;

  const q = (extra: string) => `?year=${year}&make=${encodeURIComponent(make)}${extra}`;

  const models = await json<MenuResponse>(`${MENU}/model${q('')}`);
  const names = items(models ?? {}).map((i) => i.text ?? '').filter(Boolean);
  const matched = bestModelMatch(model, names);
  if (!matched) {
    cache![key] = null;
    dirty = true;
    return null;
  }

  const options = await json<MenuResponse>(`${MENU}/options${q(`&model=${encodeURIComponent(matched)}`)}`);
  const id = items(options ?? {})[0]?.value;
  if (!id) {
    cache![key] = null;
    dirty = true;
    return null;
  }

  const record = await json<Record<string, unknown>>(`${VEHICLE}/${id}`);
  if (!record) {
    cache![key] = null;
    dirty = true;
    return null;
  }

  const facts: EpaFacts = {
    mpgCity: num(record.city08),
    mpgHighway: num(record.highway08),
    cylinders: num(record.cylinders),
    displacementL: num(record.displ),
    transmission: parseTransmission(String(record.trany ?? '')),
    drivetrain: parseDrivetrain(String(record.drive ?? '')),
    // `range` is zero for everything that burns fuel, which is not a range of 0.
    rangeMiles: num(record.range),
    fuelType: (record.fuelType as string) || null,
  };

  cache![key] = facts;
  dirty = true;
  return facts;
}

/**
 * Fills what the listing did not carry.
 *
 * Never overwrites. A listing's own drivetrain describes the specific car; the
 * EPA's describes the base variant of that model, so where they disagree the
 * listing is the better evidence about the car in front of the buyer.
 */
export async function enrichWithEpa(listing: Listing): Promise<Listing> {
  const facts = await epaFacts(listing.year, listing.make, listing.model);
  if (!facts) return listing;

  return {
    ...listing,
    mpgCity: listing.mpgCity ?? facts.mpgCity,
    mpgHighway: listing.mpgHighway ?? facts.mpgHighway,
    cylinders: listing.cylinders ?? facts.cylinders,
    displacementL: listing.displacementL ?? facts.displacementL,
    transmission: listing.transmission ?? facts.transmission,
    drivetrain: listing.drivetrain ?? facts.drivetrain,
    rangeMiles: listing.rangeMiles ?? facts.rangeMiles,
    fuelType: listing.fuelType ?? facts.fuelType,
  };
}
