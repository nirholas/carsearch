import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, quantile, histogram, linearFit, fitDepreciation, trendOverTime } from '../src/analytics/stats.js';
import { backtestFromTrend, valueAtMileage, forecastOwnership, analyzeMarket } from '../src/analytics/market.js';
import { makeListing } from '../src/core/listing.js';
import type { Listing } from '../src/core/types.js';
import { parseTransmission, parseTitleStatus, parseAccidents, parseOwners } from '../src/core/facets.js';
import { canonicalModel, parseModel, parseMake } from '../src/core/normalize.js';

test('summarize reports spread as an IQR, not a range', () => {
  const s = summarize([10, 20, 30, 40, 1000]);
  assert.equal(s.n, 5);
  assert.equal(s.median, 30);
  assert.equal(s.p25, 20);
  assert.equal(s.p75, 40);
  assert.equal(s.iqr, 20);
});

test('an empty set reports nothing rather than zero', () => {
  const s = summarize([]);
  assert.equal(s.n, 0);
  assert.equal(s.median, null);
  assert.equal(s.mean, null);
});

test('quantile interpolates', () => {
  assert.equal(quantile([0, 10], 0.5), 5);
  assert.equal(quantile([0, 100], 0.25), 25);
});

test('histogram edges land on round numbers a person would choose', () => {
  const bins = histogram([1000, 5000, 9000, 12000, 48000]);
  assert.ok(bins.length > 1);
  const step = bins[0]!.to - bins[0]!.from;
  assert.ok([1, 2, 5].includes(step / 10 ** Math.floor(Math.log10(step))), `step ${step} is not 1/2/5 x 10^n`);
  assert.equal(bins.reduce((n, b) => n + b.n, 0), 5, 'every value lands in exactly one bin');
});

test('a perfect line is recovered exactly', () => {
  const fit = linearFit([{ x: 0, y: 5 }, { x: 1, y: 7 }, { x: 2, y: 9 }])!;
  assert.equal(fit.slope, 2);
  assert.equal(fit.intercept, 5);
  assert.equal(fit.r2, 1);
});

test('a fit needs at least three points', () => {
  assert.equal(linearFit([{ x: 0, y: 1 }, { x: 1, y: 2 }]), null);
});

test('depreciation is fitted multiplicatively, so it reports a percent per 10k', () => {
  // A clean 10% loss per 10,000 miles.
  const points = Array.from({ length: 12 }, (_, i) => ({
    mileage: i * 10_000,
    price: 50_000 * 0.9 ** i,
  }));
  const curve = fitDepreciation(points)!;
  assert.ok(Math.abs(curve.percentPerTenThousandMiles - 10) < 0.5, `got ${curve.percentPerTenThousandMiles}`);
  assert.ok(curve.r2 > 0.999);
});

test('a valuation refuses to extrapolate far past its data', () => {
  const curve = fitDepreciation(
    Array.from({ length: 10 }, (_, i) => ({ mileage: 20_000 + i * 5000, price: 40_000 - i * 1500 })),
  )!;
  assert.equal(valueAtMileage(curve, 40_000)!.confidence, 'good');
  assert.equal(valueAtMileage(curve, 200_000)!.confidence, 'none');
  assert.ok(valueAtMileage(curve, 200_000)!.extrapolatedBy > 100_000);
});

test('the ownership forecast is depreciation only, and says so', () => {
  const curve = fitDepreciation(
    Array.from({ length: 10 }, (_, i) => ({ mileage: 10_000 + i * 10_000, price: 60_000 * 0.92 ** i })),
  )!;
  const f = forecastOwnership(curve, 30_000, 12_000, 3)!;
  assert.equal(f.years.length, 3);
  assert.ok(f.years[0]!.lostThisYear > 0);
  assert.ok(f.years[0]!.value > f.years[2]!.value, 'value falls with miles');
  assert.match(f.basis, /Excludes fuel, insurance/);
});

test('a trend weights each sale, not each bucket', () => {
  // One outlier week with a single sale must not set the direction against
  // forty sales pointing the other way.
  const sales = [
    ...Array.from({ length: 40 }, () => ({ date: '2026-07-06', price: 20_000 })),
    { date: '2026-07-13', price: 90_000 },
    ...Array.from({ length: 40 }, () => ({ date: '2026-07-20', price: 20_500 })),
  ];
  const t = trendOverTime(sales);
  assert.equal(t.bucket, 'week');
  assert.equal(t.populatedBuckets, 3);
  assert.ok(t.dollarsPerMonth !== null && t.dollarsPerMonth > 0, 'the 80 flat sales win over the single spike');
});

test('a backtest over a short window refuses to annualize', () => {
  const t = trendOverTime([
    { date: '2026-08-01', price: 20_000 },
    { date: '2026-08-01', price: 21_000 },
    { date: '2026-08-01', price: 22_000 },
    { date: '2026-09-01', price: 24_000 },
    { date: '2026-09-01', price: 25_000 },
    { date: '2026-09-01', price: 26_000 },
  ]);
  const b = backtestFromTrend(t);
  assert.equal(b.annualizedPercent, null, 'one month must not become an annual rate');
  assert.ok(b.entries.length >= 1);
  assert.ok(b.entries[0]!.returnPercent > 0);
});

test('a backtest flags buckets thin enough to be anecdotes', () => {
  const t = trendOverTime([
    { date: '2026-07-06', price: 20_000 },
    { date: '2026-08-03', price: 30_000 },
  ]);
  const b = backtestFromTrend(t);
  assert.equal(b.thin, true);
  assert.match(b.caveat, /Read the direction, not the number/);
});

const listing = (over: Partial<Listing>): Listing =>
  makeListing({ id: `x${Math.random()}`, sourceId: 's', title: 't', ...over });

test('the report never mixes asking prices into a sold statistic', () => {
  const rows = [
    listing({ priceKind: 'ask', price: 40_000, year: 2017, mileage: 40_000 }),
    listing({ priceKind: 'ask', price: 42_000, year: 2017, mileage: 45_000 }),
    listing({ priceKind: 'sold', price: 22_000, year: 2017, mileage: 60_000, eventDate: '2026-08-01' }),
    listing({ priceKind: 'sold', price: 24_000, year: 2017, mileage: 50_000, eventDate: '2026-08-15' }),
    listing({ priceKind: 'bid', price: 15_000, year: 2017, mileage: 50_000 }),
  ];
  const r = analyzeMarket(rows, { make: 'Porsche', model: 'Macan', yearMin: null, yearMax: null });
  assert.equal(r.counts.ask, 2);
  assert.equal(r.counts.sold, 2);
  assert.equal(r.counts.bid, 1);
  assert.equal(r.ask.median, 41_000);
  assert.equal(r.sold.median, 23_000);
  assert.equal(r.spread, 18_000);
  // The bid belongs to neither summary.
  assert.equal(r.ask.n, 2);
  assert.equal(r.sold.n, 2);
});

test('a repeated round mileage is treated as a display placeholder', () => {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) =>
      listing({ priceKind: 'sold', price: 40_000 - i * 2000, mileage: 20_000 + i * 8000, eventDate: '2026-08-01' })),
    // Six delivery-mileage cars all showing the site's placeholder "1,000 mi".
    ...Array.from({ length: 6 }, () =>
      listing({ priceKind: 'sold', price: 90_000, mileage: 1000, eventDate: '2026-08-01' })),
  ];
  const r = analyzeMarket(rows, { make: null, model: null, yearMin: null, yearMax: null });
  assert.equal(r.depreciation!.n, 6, 'the placeholder would otherwise anchor the curve');
});

test('a seller rounding a real odometer to thousands is still usable data', () => {
  // "48k-Mile" in an auction title is a genuine reading, not a placeholder, and
  // discarding it left the sold set with no mileages and no curve at all.
  const rows = Array.from({ length: 8 }, (_, i) =>
    listing({ priceKind: 'sold', price: 40_000 - i * 2000, mileage: 20_000 + i * 8000, mileageIsRounded: true, eventDate: '2026-08-01' }));
  const r = analyzeMarket(rows, { make: null, model: null, yearMin: null, yearMax: null });
  assert.equal(r.depreciation!.n, 8);
});

test('a per-year spread is withheld until enough sales back it', () => {
  const rows = [
    listing({ priceKind: 'ask', price: 40_000, year: 2023 }),
    listing({ priceKind: 'sold', price: 62_000, year: 2023, eventDate: '2026-08-01' }),
  ];
  const r = analyzeMarket(rows, { make: null, model: null, yearMin: null, yearMax: null });
  // One sale above every asking price is an outlier, not a negative spread.
  assert.equal(r.byYear[0]!.spread, null);
});

test('a slope that explains nothing is reported as flat, not as a trend', () => {
  const noise = [12_000, 45_000, 19_000, 38_000, 22_000, 41_000, 15_000, 36_000];
  const t = trendOverTime(noise.map((price, i) => ({ date: `2026-0${1 + (i % 8)}-05`, price })));
  assert.equal(t.direction, 'flat');
  assert.ok(t.r2! < 0.15);
});

/* ------------------------------------------------- facet parsing */

test('an automated manual is not a manual', () => {
  // NHTSA calls a PDK, a DSG and every other clutchless gearbox an "Automated
  // Manual Transmission (AMT)". Reading that as a manual sent 34 automatic
  // Macans to anyone filtering for three pedals.
  assert.equal(parseTransmission('Automated Manual Transmission (AMT)'), 'dual-clutch');
  assert.equal(parseTransmission('Manual/Standard'), 'manual');
  assert.equal(parseTransmission('6-Speed Manual'), 'manual');
  assert.equal(parseTransmission('7-Speed PDK'), 'dual-clutch');
  assert.equal(parseTransmission('Automatic (variable gear ratios)'), 'cvt');
});

test('a rebuilt salvage title is rebuilt, not salvage', () => {
  assert.equal(parseTitleStatus('Rebuilt Salvage Title'), 'rebuilt');
  assert.equal(parseTitleStatus('Salvage Title'), 'salvage');
  assert.equal(parseTitleStatus('Clean Carfax, clean title'), 'clean');
  assert.equal(parseTitleStatus('2017 Porsche Macan S'), null, 'silence is not a clean title');
});

test('"no accidents reported" is zero reported, and one owner is one', () => {
  assert.equal(parseAccidents('No accidents reported'), 0);
  assert.equal(parseAccidents('2 reported accidents'), 2);
  assert.equal(parseAccidents('great condition'), null);
  assert.equal(parseOwners('1 Owner'), 1);
  assert.equal(parseOwners('One-owner car'), 1);
  assert.equal(parseOwners('3 previous owners'), 3);
});

test('one spelling per model, but alphanumeric designations keep theirs', () => {
  assert.equal(canonicalModel('macan'), 'Macan');
  assert.equal(canonicalModel('Macan'), 'Macan');
  assert.equal(canonicalModel('911'), '911');
  assert.equal(canonicalModel('MX-5 Miata'), 'MX-5 Miata');
  assert.equal(canonicalModel('  '), null);
});

test('a model is read after the year, not from the start of the title', () => {
  // Auction titles put the story first. Taking the leading token gave models
  // like "29-Years-Owned" and "Vantage-Specification".
  assert.equal(parseModel('29-Years-Owned 1994 Acura NSX 5-Speed', 'Acura'), 'NSX');
  assert.equal(parseModel('Vantage-Specification 1974 Aston Martin V8 Series 3', 'Aston Martin'), 'V8');
  assert.equal(parseModel('302-Powered 1966 Ford Mustang Pickup Conversion', 'Ford'), 'Mustang');
  assert.equal(parseModel('196-Mile Albert Blue 2024 Porsche 911 S/T', 'Porsche'), '911');
  assert.equal(parseModel('2017 Porsche Macan S', 'Porsche'), 'Macan');
});

test('an abbreviation never matches inside a longer marque name', () => {
  // includes('merc') matched "Mercury", so every Mercury was filed as a
  // Mercedes-Benz and a 1968 Cougar came back in a search for G-Wagens.
  assert.equal(parseMake('30-Years-Owned 1968 Mercury Cougar 7-Litre GT-E'), 'Mercury');
  assert.equal(parseMake('1968 Shelby Mustang GT500 Fastback'), 'Shelby');
  assert.equal(parseMake('2017 Mercedes-Benz G550'), 'Mercedes-Benz');
  assert.equal(parseMake('merc 300SL'), 'Mercedes-Benz', 'the alias still works on its own');
  // Steyr-Daimler-Puch built the G-Wagen; filing it separately splits the model.
  assert.equal(parseMake('1993 Puch 230GE'), 'Mercedes-Benz');
  assert.equal(parseMake('1972 Datsun 240Z'), 'Datsun');
  assert.equal(parseMake('1961 Austin-Healey 3000'), 'Austin-Healey');
});

test('a Range Rover is a Land Rover, not a Rover', () => {
  assert.equal(parseMake('2017 Range Rover Supercharged'), 'Land Rover');
  assert.equal(parseMake('1997 Land Rover Defender 90'), 'Land Rover');
});
