import type { Listing } from './types.js';

/**
 * Deal rating measured against completed sales.
 *
 * Every incumbent that rates a deal rates it against other asking prices.
 * CarGurus compares a listing to what other sellers want; so does every "great
 * price" badge in the category. That measures the asking market against itself,
 * and if every seller in a segment is optimistic the whole segment reads as
 * fairly priced.
 *
 * This rates against what buyers actually paid. It is the one comparison that
 * cannot be gamed by sellers, and it is only possible because the index carries
 * completed auction results alongside dealer inventory.
 *
 * When there is not enough sold data the rating is null and the reason says so.
 * A confident-looking badge computed from two data points is worse than no
 * badge, because a buyer will act on it.
 */

export type DealGrade = 'great' | 'good' | 'fair' | 'high' | 'overpriced';

export interface DealRating {
  grade: DealGrade;
  /** Negative means below the sold median. */
  percentVsSold: number;
  dollarsVsSold: number;
  soldMedian: number;
  sampleSize: number;
  /** Plain-language explanation shown to the user. */
  explanation: string;
}

export interface DealUnrated {
  grade: null;
  reason: string;
}

/** Below this many completed sales, a median is noise and no badge is shown. */
export const MIN_COMPS = 3;

const THRESHOLDS: { grade: DealGrade; maxPercent: number }[] = [
  { grade: 'great', maxPercent: -15 },
  { grade: 'good', maxPercent: -5 },
  { grade: 'fair', maxPercent: 10 },
  { grade: 'high', maxPercent: 25 },
];

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function rateListing(
  listing: Pick<Listing, 'price' | 'priceKind'>,
  soldPrices: number[],
): DealRating | DealUnrated {
  if (listing.price === null) return { grade: null, reason: 'no price on this listing' };
  if (listing.priceKind !== 'ask') {
    return { grade: null, reason: 'auction bids and completed sales are not rated against the market' };
  }
  if (soldPrices.length < MIN_COMPS) {
    return {
      grade: null,
      reason: `only ${soldPrices.length} completed sale${soldPrices.length === 1 ? '' : 's'} on record, need ${MIN_COMPS}`,
    };
  }

  const soldMedian = median(soldPrices)!;
  const dollarsVsSold = Math.round(listing.price - soldMedian);
  const percentVsSold = Math.round(((listing.price - soldMedian) / soldMedian) * 1000) / 10;
  const grade = THRESHOLDS.find((t) => percentVsSold < t.maxPercent)?.grade ?? 'overpriced';

  const direction = dollarsVsSold < 0 ? 'below' : 'above';
  const explanation =
    `$${Math.abs(dollarsVsSold).toLocaleString('en-US')} ${direction} the $${Math.round(soldMedian).toLocaleString('en-US')} ` +
    `median of ${soldPrices.length} completed sales`;

  return { grade, percentVsSold, dollarsVsSold, soldMedian, sampleSize: soldPrices.length, explanation };
}

export function isRated(r: DealRating | DealUnrated): r is DealRating {
  return r.grade !== null;
}
