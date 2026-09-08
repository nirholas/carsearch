/**
 * The statistics the dashboards are built on.
 *
 * Kept separate from both the charts and the HTTP layer so that every number
 * shown to a user is computed in code that can be tested against known inputs.
 * A chart library will happily draw a wrong trend line, and nobody looking at
 * the picture can tell.
 *
 * Two rules run through all of it. Nothing is reported without its sample size,
 * because a median of four sales and a median of four hundred look identical on
 * a chart and mean completely different things. And nothing is extrapolated
 * past the data: a fit is reported with the range it was fitted over, and the
 * caller is expected to refuse to use it outside that range.
 */

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Linear-interpolated percentile, 0 to 1. */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const pos = (s.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

export interface Summary {
  n: number;
  min: number | null;
  max: number | null;
  median: number | null;
  mean: number | null;
  p25: number | null;
  p75: number | null;
  /** Interquartile range, the honest measure of spread for a skewed price set. */
  iqr: number | null;
}

export function summarize(values: number[]): Summary {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) {
    return { n: 0, min: null, max: null, median: null, mean: null, p25: null, p75: null, iqr: null };
  }
  const p25 = quantile(clean, 0.25)!;
  const p75 = quantile(clean, 0.75)!;
  return {
    n: clean.length,
    min: Math.min(...clean),
    max: Math.max(...clean),
    median: median(clean),
    mean: clean.reduce((a, b) => a + b, 0) / clean.length,
    p25,
    p75,
    iqr: p75 - p25,
  };
}

export interface Bin {
  from: number;
  to: number;
  n: number;
}

/**
 * Histogram with round, human bucket edges.
 *
 * Equal-width bins over the raw min and max produce edges like $13,847, which
 * makes an axis nobody can read. The width is snapped to a 1/2/5 x 10^n step so
 * the buckets land on numbers a person would have chosen.
 */
export function histogram(values: number[], targetBins = 24): Bin[] {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return [];
  const lo = clean[0]!;
  const hi = clean[clean.length - 1]!;
  if (hi === lo) return [{ from: lo, to: lo, n: clean.length }];

  const rough = (hi - lo) / targetBins;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10;

  const start = Math.floor(lo / step) * step;
  const bins: Bin[] = [];
  for (let edge = start; edge <= hi; edge += step) {
    bins.push({ from: edge, to: edge + step, n: 0 });
  }
  for (const v of clean) {
    const i = Math.min(Math.floor((v - start) / step), bins.length - 1);
    bins[i]!.n += 1;
  }
  return bins;
}

export interface Fit {
  /** y = intercept + slope * x */
  slope: number;
  intercept: number;
  /** Proportion of variance explained. Below about 0.2 the line is decoration. */
  r2: number;
  n: number;
  /** The x range the fit was computed over. Predicting outside it is not supported. */
  xMin: number;
  xMax: number;
}

export function linearFit(points: { x: number; y: number }[]): Fit | null {
  const pts = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length < 3) return null;

  const n = pts.length;
  const meanX = pts.reduce((s, p) => s + p.x, 0) / n;
  const meanY = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.x - meanX) ** 2;
    sxy += (p.x - meanX) * (p.y - meanY);
  }
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (const p of pts) {
    ssRes += (p.y - (intercept + slope * p.x)) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }

  const xs = pts.map((p) => p.x);
  return {
    slope,
    intercept,
    r2: ssTot === 0 ? 0 : 1 - ssRes / ssTot,
    n,
    xMin: Math.min(...xs),
    xMax: Math.max(...xs),
  };
}

export interface DepreciationCurve extends Fit {
  /** Dollars lost per 10,000 miles, at the median mileage of the sample. */
  perTenThousandMiles: number;
  /** Percent of value lost per 10,000 miles. Comparable across price brackets. */
  percentPerTenThousandMiles: number;
  /** Fitted price at a given mileage, or null outside the fitted range. */
  priceAt: number[];
}

/**
 * Fits price against mileage on a log scale.
 *
 * Depreciation is multiplicative, not additive: a car does not lose the same
 * number of dollars for its first 10,000 miles as for its hundredth. Fitting
 * log(price) makes the model say "loses 6% per 10k", which is both truer to the
 * shape of the data and comparable between a $15,000 car and a $150,000 one.
 */
export function fitDepreciation(points: { mileage: number; price: number }[]): DepreciationCurve | null {
  const usable = points.filter((p) => p.mileage > 0 && p.price > 0);
  const fit = linearFit(usable.map((p) => ({ x: p.mileage, y: Math.log(p.price) })));
  if (!fit) return null;

  const midMileage = median(usable.map((p) => p.mileage)) ?? 0;
  const priceAtMid = Math.exp(fit.intercept + fit.slope * midMileage);
  const priceAt10kMore = Math.exp(fit.intercept + fit.slope * (midMileage + 10_000));

  // A sampled curve, so the caller can draw it without knowing it is log-scaled.
  const steps = 24;
  const priceAt: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = fit.xMin + ((fit.xMax - fit.xMin) * i) / steps;
    priceAt.push(Math.exp(fit.intercept + fit.slope * x));
  }

  return {
    ...fit,
    perTenThousandMiles: priceAtMid - priceAt10kMore,
    percentPerTenThousandMiles: (1 - priceAt10kMore / priceAtMid) * 100,
    priceAt,
  };
}

export interface TrendPoint {
  /** ISO date of the bucket start. */
  date: string;
  n: number;
  median: number | null;
  p25: number | null;
  p75: number | null;
}

export interface Trend {
  points: TrendPoint[];
  bucket: 'week' | 'month';
  /** Dollars per month, from a fit over the bucket medians. Null when too thin. */
  dollarsPerMonth: number | null;
  percentPerMonth: number | null;
  r2: number | null;
  /** Span actually covered, so the UI never implies more history than exists. */
  from: string | null;
  to: string | null;
  /** Buckets holding at least one sale. The honest denominator for the trend. */
  populatedBuckets: number;
  /**
   * What the slope is actually entitled to claim.
   *
   * `flat` is returned whenever the fit explains too little of the variance to
   * support a direction, which on a real ten-week sample is the usual answer.
   * A caller that renders `dollarsPerMonth` without checking this will print
   * noise as a market trend.
   */
  direction: 'rising' | 'falling' | 'flat' | 'unknown';
}

/** Below this r2 a slope is noise. Kept here so the trend reports its own honesty. */
export const MIN_TREND_R2 = 0.15;

const DAY = 86_400_000;

function bucketStart(iso: string, bucket: 'week' | 'month'): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (bucket === 'month') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  // Weeks start Monday, which is what a market reads as a week.
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(t - dow * DAY).toISOString().slice(0, 10);
}

/**
 * Median price over time.
 *
 * The bucket is chosen from the span rather than fixed: weekly buckets over two
 * years give 104 points of noise, and monthly buckets over two months give two
 * points and a meaningless slope.
 */
export function trendOverTime(
  sales: { date: string | null; price: number | null }[],
  bucketOverride?: 'week' | 'month',
): Trend {
  const dated = sales
    .filter((s): s is { date: string; price: number } => Boolean(s.date) && s.price !== null)
    .map((s) => ({ t: Date.parse(s.date), price: s.price, date: s.date }))
    .filter((s) => Number.isFinite(s.t))
    .sort((a, b) => a.t - b.t);

  if (dated.length === 0) {
    return { points: [], bucket: 'month', dollarsPerMonth: null, percentPerMonth: null, r2: null, from: null, to: null, populatedBuckets: 0, direction: 'unknown' };
  }

  const spanDays = (dated[dated.length - 1]!.t - dated[0]!.t) / DAY;
  const bucket = bucketOverride ?? (spanDays > 400 ? 'month' : 'week');

  const groups = new Map<string, number[]>();
  for (const s of dated) {
    const key = bucketStart(s.date, bucket);
    if (!key) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s.price);
  }

  const points: TrendPoint[] = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, prices]) => ({
      date,
      n: prices.length,
      median: median(prices),
      p25: quantile(prices, 0.25),
      p75: quantile(prices, 0.75),
    }));

  /**
   * The slope is fitted over the individual sales, not the bucket medians. A
   * bucket holding one sale would otherwise carry the same weight as one
   * holding forty, which lets a single outlier week set the direction of the
   * whole market.
   */
  const monthsFrom = (t: number) => (t - dated[0]!.t) / (DAY * 30.44);
  const fit = linearFit(dated.map((s) => ({ x: monthsFrom(s.t), y: s.price })));
  const level = median(dated.map((s) => s.price)) ?? 0;

  const direction: Trend['direction'] =
    !fit ? 'unknown'
    : fit.r2 < MIN_TREND_R2 ? 'flat'
    : fit.slope > 0 ? 'rising'
    : 'falling';

  return {
    points,
    bucket,
    dollarsPerMonth: fit ? fit.slope : null,
    percentPerMonth: fit && level > 0 ? (fit.slope / level) * 100 : null,
    r2: fit ? fit.r2 : null,
    from: dated[0]!.date,
    to: dated[dated.length - 1]!.date,
    populatedBuckets: points.length,
    direction,
  };
}
