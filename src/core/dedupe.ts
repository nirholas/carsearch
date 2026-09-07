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

export function dedupe(listings: Listing[]): DedupeGroup[] {
  const groups = new Map<string, { members: Listing[]; confidence: MatchConfidence }>();
  const assigned = new Set<string>();

  const pass = (keyFn: (l: Listing) => string | null, confidence: MatchConfidence) => {
    for (const l of listings) {
      if (assigned.has(l.id)) continue;
      const k = keyFn(l);
      if (!k) continue;
      assigned.add(l.id);
      const g = groups.get(k);
      if (g) g.members.push(l);
      else groups.set(k, { members: [l], confidence });
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
