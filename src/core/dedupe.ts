import type { Listing } from './types.js';
import { isValidVin, isRoundedMileage } from './normalize.js';

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
 * Price is bucketed to $500 so that a site rounding $37,998 to $37,995 still
 * matches. Mileage is used only when it is not a display rounding.
 */
function compositeKey(l: Listing): string | null {
  if (l.year === null || l.price === null) return null;
  if (l.mileage === null || isRoundedMileage(l.mileage)) return null;
  const make = (l.make ?? '?').toLowerCase();
  const model = (l.model ?? '?').toLowerCase();
  const priceBucket = Math.round(l.price / 500);
  return `c:${make}|${model}|${l.year}|${l.mileage}|${priceBucket}`;
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

  return [...groups.values()].map(({ members, confidence }) => {
    const primary = [...members].sort((a, b) => completeness(b) - completeness(a))[0]!;
    return {
      primary,
      members,
      sources: [...new Set(members.map((m) => m.sourceId))],
      confidence: members.length === 1 ? 'exact' : confidence,
    };
  });
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
