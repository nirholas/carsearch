import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleRisk, firstQuartile, FLOOR_RATIO, MIN_COHORT } from '../src/core/title-risk.js';

/**
 * Every assertion here is about the heuristic staying quiet. It is the weakest
 * signal in the index and its failure mode is not missing a salvage car, it is
 * shouting over real data or over an honest bargain.
 */

const ask = (price: number, over: Partial<Parameters<typeof titleRisk>[0]> = {}) => ({
  price,
  priceKind: 'ask' as const,
  titleStatus: null,
  accidents: null,
  accidentFree: null,
  ...over,
});

/** A cohort whose lower quartile is 100,000: with 8 rows the index is s[2]. */
const COHORT = [100_000, 100_000, 100_000, 120_000, 130_000, 140_000, 150_000, 160_000];

test('fires only when the price is far under the cohort floor', () => {
  assert.equal(firstQuartile(COHORT), 100_000);
  // The Urus case: advertised clean, airbags deployed, priced at 0.55 of floor.
  assert.equal(titleRisk(ask(55_000), COHORT).suspect, true);
  // A genuinely cheap but ordinary car.
  assert.equal(titleRisk(ask(85_000), COHORT).suspect, false);
});

test('the boundary is exclusive, so exactly at the ratio is not suspect', () => {
  const atFloor = 100_000 * FLOOR_RATIO;
  assert.equal(titleRisk(ask(atFloor), COHORT).suspect, false);
  assert.equal(titleRisk(ask(atFloor - 1), COHORT).suspect, true);
});

test('published title data silences it, in both directions', () => {
  // Real evidence of a brand: this file must not add a second, weaker opinion.
  const branded = titleRisk(ask(55_000, { titleStatus: 'salvage' }), COHORT);
  assert.equal(branded.suspect, false);
  assert.match(branded.reason, /published/);

  // Real evidence of a clean title on a suspiciously cheap car. Still silent:
  // contradicting a published field with a price guess is the worse error.
  const clean = titleRisk(ask(55_000, { titleStatus: 'clean' }), COHORT);
  assert.equal(clean.suspect, false);
});

test('published accident history silences it, including an explicit zero', () => {
  assert.equal(titleRisk(ask(55_000, { accidents: 0 }), COHORT).suspect, false);
  assert.equal(titleRisk(ask(55_000, { accidentFree: false }), COHORT).suspect, false);
  // Absent is not the same as zero, and only absent lets the heuristic speak.
  assert.equal(titleRisk(ask(55_000, { accidents: null, accidentFree: null }), COHORT).suspect, true);
});

test('a bid is not an asking price and is never rated', () => {
  // The "$56,000 911" that was a live Cars & Bids bid, not a bargain.
  const bid = titleRisk({ ...ask(56_000), priceKind: 'bid' }, COHORT);
  assert.equal(bid.suspect, false);
  assert.match(bid.reason, /bid/);
});

test('a thin cohort produces no opinion', () => {
  const thin = [100_000, 120_000, 140_000];
  assert.ok(thin.length < MIN_COHORT);
  const r = titleRisk(ask(20_000), thin);
  assert.equal(r.suspect, false);
  assert.equal(r.ratio, null);
  assert.match(r.reason, /need 8/);
});

test('a listing with no price produces no opinion', () => {
  assert.equal(titleRisk(ask(0, { price: null } as never), COHORT).suspect, false);
});

test('junk prices in the cohort are dropped before the quartile is taken', () => {
  // A zero or a negative would drag the floor to nothing and silence every flag.
  const dirty = [0, -1, ...COHORT];
  assert.equal(firstQuartile(dirty.filter((p) => p > 0)), 100_000);
  assert.equal(titleRisk(ask(55_000), dirty).suspect, true);
});

test('the reason is written for a buyer, not a developer', () => {
  const r = titleRisk(ask(55_000), COHORT);
  assert.match(r.reason, /\$100,000/);
  assert.match(r.reason, /Verify the title/);
});

test('a car cheaper than a title report produces no opinion', () => {
  // Two of six production flags were $1,000 beaters. The ratio was real and the
  // advice was not: a ~$10 NMVTIS report is not worth buying for a $1,000 car.
  const beaters = [2000, 2000, 2000, 2500, 3000, 3200, 3500, 4000];
  const r = titleRisk(ask(1_000), beaters);
  assert.equal(r.suspect, false);
  assert.match(r.reason, /costs more than the risk/);
  // The same ratio on real money still fires.
  assert.equal(titleRisk(ask(55_000), COHORT).suspect, true);
});
