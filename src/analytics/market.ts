import type { Listing } from '../core/types.js';
import {
  summarize, histogram, median, fitDepreciation, trendOverTime,
  type Summary, type Bin, type DepreciationCurve, type Trend,
} from './stats.js';

/**
 * The market dashboard: everything a buyer would want to know about a model
 * before deciding what to pay for one.
 *
 * The organising idea is the same one the whole product rests on. Asking prices
 * describe what sellers hope for; completed sales describe what the market did.
 * Every derived quantity here that claims to be about VALUE is computed from
 * sold records only, and every quantity computed from asks is labelled as an
 * ask. Mixing the two produces confident numbers that are wrong, which is the
 * defining failure of this category.
 */

export interface YearRow {
  year: number;
  askCount: number;
  askMedian: number | null;
  soldCount: number;
  soldMedian: number | null;
  /** What sellers ask above what buyers paid, for this year alone. */
  spread: number | null;
  medianMileage: number | null;
}

export interface MileageBand {
  from: number;
  to: number;
  askCount: number;
  askMedian: number | null;
  soldCount: number;
  soldMedian: number | null;
}

export interface Valuation {
  /** Predicted sold price for a car at this mileage, from the fitted curve. */
  price: number;
  /** How far outside the fitted mileage range the request sat, in miles. 0 when inside. */
  extrapolatedBy: number;
  confidence: 'good' | 'weak' | 'none';
  basis: string;
}

export interface BacktestEntry {
  date: string;
  medianAtEntry: number;
  n: number;
  /** Change from that bucket's median to the most recent bucket's median. */
  returnPercent: number;
  returnDollars: number;
}

export interface Backtest {
  from: string | null;
  to: string | null;
  months: number;
  entries: BacktestEntry[];
  currentMedian: number | null;
  annualizedPercent: number | null;
  best: BacktestEntry | null;
  worst: BacktestEntry | null;
  /** True when any bucket rests on fewer sales than are meaningful. */
  thin: boolean;
  /** Stated in the response, and rendered, so nobody reads more into this than it says. */
  caveat: string;
}

export interface OwnershipForecast {
  milesPerYear: number;
  years: { year: number; miles: number; value: number; lostThisYear: number }[];
  totalDepreciation: number;
  /** Depreciation only. Not a running cost estimate, and labelled as such. */
  basis: string;
}

export interface MarketReport {
  scope: { make: string | null; model: string | null; yearMin: number | null; yearMax: number | null };
  counts: { ask: number; bid: number; sold: number };
  ask: Summary;
  sold: Summary;
  /** Median ask minus median sold. The number no incumbent publishes. */
  spread: number | null;
  spreadPercent: number | null;
  askHistogram: Bin[];
  soldHistogram: Bin[];
  depreciation: (DepreciationCurve & { points: { mileage: number; price: number; year: number | null; title: string; url: string | null }[] }) | null;
  trend: Trend;
  byYear: YearRow[];
  byMileage: MileageBand[];
  bySource: { sourceId: string; n: number; median: number | null }[];
  backtest: Backtest;
  /** Days a listing sits before it sells or is delisted, where observable. */
  daysOnMarket: Summary;
}

/** Below this many sales in a bucket, a median is an anecdote. */
export const THIN_BUCKET = 3;

/** Below this many sales, a per-year spread is one transaction wearing a suit. */
export const MIN_SPREAD_SAMPLE = 3;

/**
 * Below this r2, a fitted slope is noise and must not be reported as a
 * direction.
 *
 * Real completed-sale data across a handful of weeks routinely fits at r2 0.01,
 * which is to say the line explains one percent of what the prices did. Printing
 * "up 10.9% a month" from that would be the single most misleading number on the
 * page, so the trend reports `direction: 'flat'` and the UI says so instead.
 */
export const MIN_TREND_R2 = 0.15;

/**
 * Mileage values that are a site's display placeholder rather than an odometer.
 *
 * The signal is repetition: CarMax shows "1,000 mi" on every delivery-mileage
 * car, so that exact value lands on dozens of rows. A genuine odometer reading
 * repeating exactly across many different cars does not happen. This is
 * self-calibrating, which the previous rule was not: it excluded anything
 * rounded to a thousand, and that threw away every auction record whose title
 * read "48k-Mile", leaving no sold mileages at all and therefore no
 * depreciation curve.
 */
export function placeholderMileages(rows: Listing[], minRepeats = 5): Set<number> {
  const counts = new Map<number, number>();
  for (const r of rows) {
    if (r.mileage === null) continue;
    counts.set(r.mileage, (counts.get(r.mileage) ?? 0) + 1);
  }
  const out = new Set<number>();
  for (const [value, n] of counts) {
    // Only round values are suspect; 47,213 appearing twice is a coincidence.
    if (n >= minRepeats && value % 1000 === 0) out.add(value);
  }
  return out;
}

const MILEAGE_BANDS: [number, number][] = [
  [0, 15_000], [15_000, 30_000], [30_000, 50_000], [50_000, 75_000],
  [75_000, 100_000], [100_000, 150_000], [150_000, Number.MAX_SAFE_INTEGER],
];

const prices = (rows: Listing[]): number[] =>
  rows.map((r) => r.price).filter((p): p is number => p !== null && p > 0);

export function analyzeMarket(
  listings: Listing[],
  scope: MarketReport['scope'],
  daysOnMarketById: Map<string, number> = new Map(),
): MarketReport {
  const ask = listings.filter((l) => l.priceKind === 'ask');
  const bid = listings.filter((l) => l.priceKind === 'bid');
  const sold = listings.filter((l) => l.priceKind === 'sold');

  const askSummary = summarize(prices(ask));
  const soldSummary = summarize(prices(sold));
  const spread =
    askSummary.median !== null && soldSummary.median !== null ? askSummary.median - soldSummary.median : null;

  /**
   * The depreciation curve is fitted on completed sales only. Fitting it on
   * asks would measure how sellers price mileage, which is a claim about
   * sellers, not about the car.
   */
  const placeholders = placeholderMileages(listings);
  const curvePoints = sold
    .filter((l) => l.mileage !== null && l.mileage > 0 && l.price !== null && l.price > 0 && !placeholders.has(l.mileage))
    .map((l) => ({ mileage: l.mileage!, price: l.price!, year: l.year, title: l.title, url: l.url }));
  const fitted = fitDepreciation(curvePoints);
  const depreciation = fitted ? { ...fitted, points: curvePoints } : null;

  const trend = trendOverTime(sold.map((l) => ({ date: l.eventDate, price: l.price })));

  const years = [...new Set(listings.map((l) => l.year).filter((y): y is number => y !== null))].sort((a, b) => b - a);
  const byYear: YearRow[] = years.map((year) => {
    const a = ask.filter((l) => l.year === year);
    const s = sold.filter((l) => l.year === year);
    const am = median(prices(a));
    const sm = median(prices(s));
    return {
      year,
      askCount: a.length,
      askMedian: am,
      soldCount: s.length,
      soldMedian: sm,
      // A spread computed against a single sale is not a market observation.
      spread: am !== null && sm !== null && s.length >= MIN_SPREAD_SAMPLE ? am - sm : null,
      medianMileage: median(
        [...a, ...s].map((l) => l.mileage).filter((m): m is number => m !== null),
      ),
    };
  });

  const byMileage: MileageBand[] = MILEAGE_BANDS.map(([from, to]) => {
    const inBand = (l: Listing) => l.mileage !== null && l.mileage >= from && l.mileage < to;
    const a = ask.filter(inBand);
    const s = sold.filter(inBand);
    return {
      from,
      to: to === Number.MAX_SAFE_INTEGER ? -1 : to,
      askCount: a.length,
      askMedian: median(prices(a)),
      soldCount: s.length,
      soldMedian: median(prices(s)),
    };
  }).filter((b) => b.askCount + b.soldCount > 0);

  const sourceIds = [...new Set(listings.map((l) => l.sourceId))];
  const bySource = sourceIds
    .map((sourceId) => {
      const rows = listings.filter((l) => l.sourceId === sourceId);
      return { sourceId, n: rows.length, median: median(prices(rows)) };
    })
    .sort((a, b) => b.n - a.n);

  return {
    scope,
    counts: { ask: ask.length, bid: bid.length, sold: sold.length },
    ask: askSummary,
    sold: soldSummary,
    spread,
    spreadPercent: spread !== null && soldSummary.median ? (spread / soldSummary.median) * 100 : null,
    askHistogram: histogram(prices(ask)),
    soldHistogram: histogram(prices(sold)),
    depreciation,
    trend,
    byYear,
    byMileage,
    bySource,
    backtest: backtestFromTrend(trend),
    daysOnMarket: summarize(
      listings.map((l) => daysOnMarketById.get(l.id)).filter((d): d is number => d !== undefined && d >= 0),
    ),
  };
}

/**
 * What a buyer at each past point would be sitting on today, at the median.
 *
 * This is a backtest on completed transactions, not on asking prices, which is
 * the only version of it that means anything: an index of what sellers wanted
 * would show a market that never falls.
 *
 * It is deliberately not annualized from a two-month window without saying so.
 * The `caveat` and `thin` fields exist to be rendered, not to be dropped by the
 * UI, because the failure mode here is a confident 400% annualized figure
 * extrapolated from six sales in nine weeks.
 */
export function backtestFromTrend(trend: Trend): Backtest {
  const populated = trend.points.filter((p) => p.median !== null);
  const latest = populated[populated.length - 1];
  const currentMedian = latest?.median ?? null;

  if (!currentMedian || populated.length < 2) {
    return {
      from: trend.from, to: trend.to, months: 0, entries: [], currentMedian,
      annualizedPercent: null, best: null, worst: null, thin: true,
      caveat: 'Not enough dated sales to compare one period against another.',
    };
  }

  const entries: BacktestEntry[] = populated.slice(0, -1).map((p) => ({
    date: p.date,
    medianAtEntry: p.median!,
    n: p.n,
    returnPercent: ((currentMedian - p.median!) / p.median!) * 100,
    returnDollars: currentMedian - p.median!,
  }));

  const first = populated[0]!;
  const months =
    (Date.parse(latest!.date) - Date.parse(first.date)) / (86_400_000 * 30.44);
  const totalReturn = (currentMedian - first.median!) / first.median!;
  /**
   * Compounding a sub-quarter window to a year turns noise into a headline, so
   * it is simply not reported below a quarter.
   */
  const annualizedPercent =
    months >= 3 ? ((1 + totalReturn) ** (12 / months) - 1) * 100 : null;

  const sorted = [...entries].sort((a, b) => a.returnPercent - b.returnPercent);
  const thin = populated.some((p) => p.n < THIN_BUCKET);

  return {
    from: trend.from,
    to: trend.to,
    months: Math.round(months * 10) / 10,
    entries,
    currentMedian,
    annualizedPercent,
    best: sorted[sorted.length - 1] ?? null,
    worst: sorted[0] ?? null,
    thin,
    caveat: thin
      ? `Some ${trend.bucket}s rest on fewer than ${THIN_BUCKET} sales. Read the direction, not the number.`
      : `Median of completed sales per ${trend.bucket} over ${Math.round(months * 10) / 10} months. Not adjusted for mileage or condition.`,
  };
}

/**
 * Predicted sold price at a given mileage.
 *
 * Refuses rather than guesses outside the range it was fitted over. A curve fit
 * between 20k and 70k miles says nothing about a 190k-mile car, and returning a
 * number anyway is how a valuation tool becomes a liability.
 */
export function valueAtMileage(curve: DepreciationCurve | null, mileage: number): Valuation | null {
  if (!curve) return null;
  const price = Math.exp(curve.intercept + curve.slope * mileage);
  const extrapolatedBy =
    mileage < curve.xMin ? curve.xMin - mileage : mileage > curve.xMax ? mileage - curve.xMax : 0;

  const confidence: Valuation['confidence'] =
    extrapolatedBy > 0 || curve.r2 < 0.2 || curve.n < 8 ? (extrapolatedBy > 25_000 ? 'none' : 'weak') : 'good';

  return {
    price: Math.round(price),
    extrapolatedBy: Math.round(extrapolatedBy),
    confidence,
    basis:
      `fitted on ${curve.n} completed sales between ` +
      `${Math.round(curve.xMin).toLocaleString('en-US')} and ${Math.round(curve.xMax).toLocaleString('en-US')} miles ` +
      `(r2 ${curve.r2.toFixed(2)})`,
  };
}

/**
 * What holding the car is likely to cost in depreciation alone.
 *
 * Depreciation is the largest cost of owning a used car and the one no listing
 * site puts a number on. This is that number and nothing else: no fuel, no
 * insurance, no maintenance. The `basis` string says so and is meant to be
 * shown next to the figure.
 */
export function forecastOwnership(
  curve: DepreciationCurve | null,
  startMileage: number,
  milesPerYear = 10_000,
  years = 5,
): OwnershipForecast | null {
  if (!curve) return null;
  const value = (m: number) => Math.exp(curve.intercept + curve.slope * m);

  const rows: OwnershipForecast['years'] = [];
  let previous = value(startMileage);
  for (let y = 1; y <= years; y += 1) {
    const miles = startMileage + milesPerYear * y;
    const v = value(miles);
    rows.push({ year: y, miles, value: Math.round(v), lostThisYear: Math.round(previous - v) });
    previous = v;
  }

  return {
    milesPerYear,
    years: rows,
    totalDepreciation: Math.round(value(startMileage) - previous),
    basis:
      `Depreciation only, from the same ${curve.n}-sale curve. Excludes fuel, insurance, ` +
      `maintenance and tyres. Beyond ${Math.round(curve.xMax).toLocaleString('en-US')} miles it is an extrapolation.`,
  };
}
