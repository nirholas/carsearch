import type { Listing } from './types.js';

/**
 * Last-resort title risk, inferred from price alone.
 *
 * This is deliberately the weakest signal in the index and it must stay that
 * way. Copart, IAA and KBB publish real title and history fields; when any of
 * them speaks about a car, that is evidence and this file must not contradict
 * it. What follows is for the large remainder where every source was silent,
 * which is most private-party and many dealer listings.
 *
 * The rule came out of hand-checking the cheapest car in each exotic category
 * during the carbide prototype. All three were branded:
 *
 *   $99,999 Audi R8        salvage
 *   $99,999 McLaren 650S   salvage
 *   $100,479 Lamborghini Urus, advertised "Clean Title", and the same seller's
 *            own description read "As Is, Cash Only, Airbags Deployed, Key
 *            Missing."
 *
 * That last one is why price is worth reading at all: the structured title
 * field said clean and was wrong, while the price said otherwise and was right.
 * A re-run over a later 1,560-car sweep re-flagged the same cars and also caught
 * a "$56,000 911" that turned out to be a live auction bid rather than an ask,
 * which is handled here by refusing to rate anything that is not an ask.
 *
 * The cohort must be keyed on trim, and that is not a detail.
 *
 * Wired without it on 2026-09-09 this produced four flags and all four were
 * false positives. The cohort `|cayman|2016` holds twenty cars from $50,998 to
 * $124,999 and eighteen are GT4s, so its lower quartile is $90,216 and a
 * correctly-priced base Cayman reads as 43% under the floor. A dispersion guard
 * was tried and rejected: it suppresses that cohort's sibling (p90/p10 of 2.41)
 * but not the Cayman one (1.62), because when the cheap subgroup is small both
 * percentiles land inside the expensive cluster. No threshold separates them,
 * since the problem is not spread, it is two different cars sharing a name.
 *
 * `core/trim.ts` now resolves the variant, and re-running the same measurement
 * with trim in the cohort key drops those four flags to one: a 2024 Taycan Base
 * at $48,921 with 15,747 miles, against a trim-matched cohort whose cheapest
 * comparable is $88,900. That is the shape this rule is for.
 *
 * Residual risk worth knowing: a car whose trim did not parse falls into the
 * base bucket. An expensive one landing there raises the floor and makes a
 * false positive MORE likely, not less, so the failure is not safe by default.
 * Widening the tables in `trim.ts` is what shrinks it.
 *
 * What this does NOT do, on purpose:
 *
 *   - It never sets `titleStatus`. A cheap car is not evidence of a brand, it
 *     is evidence that a question should be asked. The output is a prompt to
 *     verify, never a fact to filter on.
 *   - It never fires when a source supplied real title or accident data, in
 *     either direction. Corroborating real data adds nothing and double-counts;
 *     contradicting it is worse.
 *   - It never fires on a thin cohort. Below the minimum, the first quartile is
 *     one or two cars and the "floor" is whatever the cheapest of them happens
 *     to be.
 */

/**
 * A price this far below the cohort's first quartile is the flag. Tuned on the
 * exotic sweep: 0.62 caught all three branded cars while leaving every
 * legitimately cheap high-mileage example alone. Raising it produces false
 * positives on honest project cars, which are a real and legitimate segment.
 */
export const FLOOR_RATIO = 0.62;

/** Below this many priced comparables the quartile is noise, not a floor. */
export const MIN_COHORT = 8;

/**
 * Below this the advice costs more than the car.
 *
 * The output of this flag is "pay for a title report and think twice before
 * travelling". An NMVTIS report is about $10, so on a $1,000 Altima that
 * counsel is uneconomic even when the ratio is real, and a run over production
 * showed exactly that: two of six flags were $1,000 beaters whose cohort
 * quartile was $2,000. The ratio was not wrong, the advice was. This rule earns
 * its keep on the money at risk, not on the percentage.
 */
export const MIN_PRICE = 5_000;

export interface TitleRisk {
  /** True only when the price is unexplained by anything the index knows. */
  suspect: boolean;
  /** Null when no opinion was formed, with the reason why. */
  ratio: number | null;
  reason: string;
}

export function firstQuartile(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 4)]!;
}

/**
 * `cohortPrices` should be asking prices for the same model in a comparable
 * year band, including this listing. The caller owns that definition because
 * cohorting is a product decision, not an arithmetic one.
 */
export function titleRisk(
  listing: Pick<Listing, 'price' | 'priceKind' | 'titleStatus' | 'accidents' | 'accidentFree'>,
  cohortPrices: number[],
): TitleRisk {
  const none = (reason: string): TitleRisk => ({ suspect: false, ratio: null, reason });

  if (listing.price === null) return none('no price on this listing');
  if (listing.priceKind !== 'ask') {
    return none('a bid or a completed sale is not an asking price and cannot be underpriced');
  }

  // Real data wins, always. Silence is the only case this file is for.
  if (listing.titleStatus !== null) {
    return none(`title status is published as "${listing.titleStatus}", no inference needed`);
  }
  if (listing.accidents !== null || listing.accidentFree !== null) {
    return none('accident history is published for this car, no inference needed');
  }

  if (listing.price < MIN_PRICE) {
    return none(`under $${MIN_PRICE.toLocaleString('en-US')}, where a title report costs more than the risk`);
  }

  const priced = cohortPrices.filter((p) => Number.isFinite(p) && p > 0);
  if (priced.length < MIN_COHORT) {
    return none(`only ${priced.length} comparable price${priced.length === 1 ? '' : 's'}, need ${MIN_COHORT}`);
  }

  const floor = firstQuartile(priced)!;
  if (floor <= 0) return none('cohort has no usable price floor');

  const ratio = listing.price / floor;
  if (ratio >= FLOOR_RATIO) {
    return { suspect: false, ratio, reason: 'price is within the normal range for this cohort' };
  }

  const pct = Math.round((1 - ratio) * 100);
  return {
    suspect: true,
    ratio,
    reason:
      `${pct}% below the $${Math.round(floor).toLocaleString('en-US')} lower quartile for comparable cars, ` +
      `and no source published a title or accident record. Verify the title before travelling.`,
  };
}
