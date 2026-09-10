import type { Listing } from './types.js';
import { isValidVin, isRoundedMileage } from './normalize.js';
import { TITLE_STATUSES } from './facets.js';

/**
 * Deduplication.
 *
 * The same car appears on four sites simultaneously. Listing counts everywhere
 * else are inflated because nobody does this, and a buyer scrolling the same
 * Macan five times has a worse experience than one who sees it once with five
 * source badges.
 *
 * The key cascade is deliberate. VIN is exact and only CarMax publishes it in
 * listing markup today. Everything else falls back to a composite that works
 * because exact mileage is close to unique, and degrades honestly when it is
 * not: delivery-mileage cars all share `1,000 mi`, so a rounded mileage is
 * excluded from the composite rather than trusted.
 */

export type MatchConfidence = 'exact' | 'strong' | 'weak';

export interface DedupeGroup {
  /** The record shown to a user, chosen as the most complete of the group. */
  primary: Listing;
  /** Every listing in the group, including the primary. */
  members: Listing[];
  /** Distinct source ids the car was seen on. */
  sources: string[];
  confidence: MatchConfidence;
}

function vinKey(l: Listing): string | null {
  return isValidVin(l.vin) ? `vin:${l.vin.toUpperCase()}` : null;
}

/**
 * Composite key for sources that do not publish a VIN.
 *
 * An exact odometer reading is the discriminator. Two 2015 BMW i8s that both
 * read 30,191 miles are one car, and requiring the price to agree as well is
 * what stopped that pair merging: an aggregator applies its own markup, so the
 * same car was $39,999 on one site and $40,653 on another. Bucketing to $500
 * put them either side of a boundary, the group split, and the copy carrying
 * FRAME_DAMAGE stopped speaking for the copy that carried no history at all.
 *
 * Price is therefore checked as a tolerance afterwards rather than folded into
 * the key. Mileage is used only when it is not a display rounding, because
 * "30,000 miles" is a marketing number that many different cars share.
 */
function compositeKey(l: Listing): string | null {
  if (l.year === null || l.price === null) return null;
  if (l.mileage === null || isRoundedMileage(l.mileage)) return null;
  const make = (l.make ?? '?').toLowerCase();
  const model = (l.model ?? '?').toLowerCase();
  return `c:${make}|${model}|${l.year}|${l.mileage}`;
}

/**
 * How far two listings of the same car may disagree on price.
 *
 * Aggregator markups on the sample that motivated this ran from 0.4% to 1.6%.
 * The allowance is far wider than that because the cost of splitting a real
 * pair (a damage flag stops reaching one of them) is worse than the cost of a
 * rare over-merge, which the history rules then resolve toward the worse news.
 */
const PRICE_TOLERANCE = 0.15;

/**
 * How far two listings of the same car may disagree on the odometer.
 *
 * The weak key does not look at mileage at all, so without this a 21,000 mile
 * car and a 53,929 mile car of the same year and price are one listing. The
 * floor is absolute because two sites reporting the same low-mileage car can
 * differ by a few hundred miles and still mean it.
 */
const MILEAGE_TOLERANCE = 0.1;
const MILEAGE_FLOOR = 2000;

/**
 * Splits a keyed group into the cars it actually contains.
 *
 * Members are walked in order of the dimension being tested and a new cluster
 * starts wherever the gap to the previous one exceeds tolerance, so a genuine
 * pair a few percent apart stays together while two cars that merely share a
 * key do not. Price runs first, then mileage within each price cluster, because
 * the two keys this guards fail in different ways: the composite key ignores
 * price, and the weak key ignores mileage.
 *
 * A member that states nothing on the dimension cannot contradict anyone, so it
 * stays with the cluster it is walking through rather than starting its own.
 */
function splitConflicting(members: Listing[]): Listing[][] {
  return cluster(members, (l) => l.price, PRICE_TOLERANCE, 0)
    .flatMap((m) => cluster(m, (l) => l.mileage, MILEAGE_TOLERANCE, MILEAGE_FLOOR));
}

/**
 * Puts back together any clusters that share a VIN.
 *
 * A VIN is the one identifier that cannot coincide, so two listings carrying
 * the same one are the same car however far apart their prices or odometers
 * are. Two sites quoting a $20,000 difference for one VIN is a disagreement
 * about the car, not evidence of two cars.
 */
function rejoinByVin(clusters: Listing[][]): Listing[][] {
  const home = new Map<string, number>();
  const out: Listing[][] = [];
  for (const group of clusters) {
    const vins = [...new Set(group.map((l) => (isValidVin(l.vin) ? l.vin.toUpperCase() : null)).filter((v) => v !== null))];
    const existing = vins.map((v) => home.get(v!)).find((i) => i !== undefined);
    const index = existing ?? out.push([]) - 1;
    out[index]!.push(...group);
    for (const v of vins) home.set(v!, index);
  }
  return out.filter((g) => g.length > 0);
}

function cluster(
  members: Listing[],
  value: (l: Listing) => number | null,
  tolerance: number,
  floor: number,
): Listing[][] {
  if (members.length < 2) return [members];
  const stated = members.filter((l) => value(l) !== null).sort((a, b) => value(a)! - value(b)!);
  const silent = members.filter((l) => value(l) === null);
  if (stated.length === 0) return [members];

  const clusters: Listing[][] = [[stated[0]!]];
  for (const l of stated.slice(1)) {
    const previous = value(clusters.at(-1)!.at(-1)!)!;
    const allowed = Math.max(previous * tolerance, floor);
    if (Math.abs(value(l)! - previous) > allowed) clusters.push([l]);
    else clusters.at(-1)!.push(l);
  }
  clusters[0]!.push(...silent);
  return clusters;
}

/**
 * Weak key for the remainder. Deliberately coarse, and only ever used to group
 * records that already failed both stronger tests.
 */
function weakKey(l: Listing): string | null {
  if (l.year === null || l.price === null) return null;
  const make = (l.make ?? '?').toLowerCase();
  const model = (l.model ?? '?').toLowerCase();
  return `w:${make}|${model}|${l.year}|${Math.round(l.price / 1000)}`;
}

/** How many fields a record populates, used to pick the best representative. */
function completeness(l: Listing): number {
  const fields = [l.vin, l.url, l.mileage, l.trim, l.series, l.location, l.imageUrl, l.bodyType, l.exteriorColor];
  return fields.filter((f) => f !== null && f !== undefined && f !== '').length;
}

/**
 * Points every weaker key a listing answers to at the group it landed in.
 *
 * Only ever adds an alias that is not already claimed, so the first (strongest)
 * group to claim a key keeps it.
 */
function registerAliases(l: Listing, group: string, aliases: Map<string, string>): void {
  for (const k of [compositeKey(l), weakKey(l)]) {
    if (k && k !== group && !aliases.has(k)) aliases.set(k, group);
  }
}

export function dedupe(listings: Listing[]): DedupeGroup[] {
  const groups = new Map<string, { members: Listing[]; confidence: MatchConfidence }>();
  const assigned = new Set<string>();

  /**
   * Every key a listing answers to, so a weaker pass can still find a group a
   * stronger pass already made.
   *
   * Without this, matching by VIN first REMOVED the listing from every later
   * pass, and a VIN-bearing record could never absorb its own VIN-less
   * duplicate. A 2019 Macan at $27,998 with 53,929 miles was in the index twice,
   * once from CarMax carrying WP1AA2A52KLB01337 and once from CarGurus carrying
   * no VIN at all, and it reached a real buyer's results as two cars. Identical
   * year, model, price and odometer; only the field one source withholds
   * differed.
   */
  const aliases = new Map<string, string>();

  const pass = (keyFn: (l: Listing) => string | null, confidence: MatchConfidence) => {
    for (const l of listings) {
      if (assigned.has(l.id)) continue;
      const k = keyFn(l);
      if (!k) continue;
      assigned.add(l.id);
      // A group this listing already belongs to under a stronger key wins, so
      // the merge keeps that group's confidence rather than being demoted.
      const target = aliases.get(k) ?? k;
      const g = groups.get(target);
      if (g) g.members.push(l);
      else groups.set(k, { members: [l], confidence });
      registerAliases(l, aliases.get(k) ?? k, aliases);
    }
  };

  // Strongest key first, so a VIN match is never demoted to a composite match.
  pass(vinKey, 'exact');
  pass(compositeKey, 'strong');
  pass(weakKey, 'weak');

  // Anything with no usable key stands alone rather than being force-merged.
  for (const l of listings) {
    if (assigned.has(l.id)) continue;
    groups.set(`solo:${l.id}`, { members: [l], confidence: 'weak' });
  }

  /**
   * Every group is checked, including one a VIN opened.
   *
   * Labelling the whole group `exact` because a VIN opened it is not safe: the
   * alias path lets a listing with no VIN join that group on the weak key, and
   * exempting the group then exempted the stranger too. A 21,000 mile Macan
   * joined a 53,929 mile one that way. The VIN itself is still never
   * second-guessed, so listings that share one are put back together after the
   * split rather than being kept out of it.
   */
  const settled: { members: Listing[]; confidence: MatchConfidence }[] = [];
  for (const { members, confidence } of groups.values()) {
    for (const group of rejoinByVin(splitConflicting(members))) {
      settled.push({ members: group, confidence });
    }
  }

  return settled.map(({ members, confidence }) => {
    const best = [...members].sort((a, b) => completeness(b) - completeness(a))[0]!;
    return {
      primary: members.length === 1 ? best : withGroupHistory(best, members),
      members,
      sources: [...new Set(members.map((m) => m.sourceId))],
      confidence: members.length === 1 ? 'exact' : confidence,
    };
  });
}

/**
 * The chosen record, carrying the worst history any member of the group states.
 *
 * Picking one whole listing to represent the group loses every field the other
 * members hold, and for history that is not a cosmetic loss. A live 2017 BMW i8
 * appeared on two sites at once: cars.com published no history and KBB published
 * SALVAGE_TITLE. The cars.com row had more fields, so it was chosen, and the car
 * was presented to a buyer as one whose title nobody had recorded, at the third
 * cheapest price in the country. The saving and the salvage brand were the same
 * fact, and only one of them was shown.
 *
 * So history merges rather than being inherited: a stated brand beats silence,
 * the more severe brand beats the milder one, and any member reporting an
 * accident outweighs any member reporting none. The bias is deliberately toward
 * the worse news, because a buyer who is wrongly warned loses a car and a buyer
 * who is wrongly reassured loses the money.
 */
function withGroupHistory(best: Listing, members: Listing[]): Listing {
  const severity = (t: Listing['titleStatus']): number =>
    t === null || t === 'unknown' ? -1 : TITLE_STATUSES.indexOf(t);

  let titleStatus = best.titleStatus;
  for (const m of members) {
    if (severity(m.titleStatus) > severity(titleStatus)) titleStatus = m.titleStatus;
  }

  const stated = <K extends keyof Listing>(key: K): Listing[K] | null => {
    for (const m of members) if (m[key] !== null && m[key] !== undefined) return m[key];
    return null;
  };

  const accidentFree = members.some((m) => m.accidentFree === false)
    ? false
    : members.some((m) => m.accidentFree === true)
      ? true
      : null;

  return {
    ...best,
    titleStatus,
    accidentFree,
    accidents: accidentFree === false ? null : (stated('accidents') as number | null),
    owners: best.owners ?? (stated('owners') as number | null),
    serviceRecords: best.serviceRecords ?? (stated('serviceRecords') as boolean | null),
  };
}

/** Convenience: how much duplication a result set actually carried. */
export function dedupeStats(listings: Listing[], groups: DedupeGroup[]) {
  const duplicated = groups.filter((g) => g.members.length > 1);
  return {
    rawListings: listings.length,
    uniqueVehicles: groups.length,
    duplicateGroups: duplicated.length,
    duplicatesRemoved: listings.length - groups.length,
    crossSourceGroups: duplicated.filter((g) => g.sources.length > 1).length,
  };
}
