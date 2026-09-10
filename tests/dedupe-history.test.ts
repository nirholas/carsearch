import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupe } from '../src/core/dedupe.js';
import type { Listing } from '../src/core/types.js';

const base = (over: Partial<Listing>): Listing =>
  ({
    id: 'x', sourceId: 's', sourceListingId: '1', url: 'https://example.invalid/1',
    title: '2017 BMW i8', year: 2017, make: 'BMW', model: 'i8', trim: null, series: null,
    vin: 'WBY2Z2C56HV676323', price: 41991, priceKind: 'ask', currency: 'USD',
    mileage: 47209, mileageIsRounded: false, location: null, sellerType: null,
    bodyType: null, exteriorColor: null, fuelType: null, eventDate: null, imageUrl: null,
    titleStatus: null, owners: null, accidents: null, accidentFree: null, serviceRecords: null,
    firstSeen: '2026-09-10T00:00:00Z', lastSeen: '2026-09-10T00:00:00Z',
    ...over,
  }) as Listing;

/**
 * The group's representative is the most complete listing, and completeness is
 * counted over descriptive fields. A richer listing that says nothing about the
 * title would otherwise silence a poorer one that says "salvage".
 */
test('a salvage brand on any member survives into the representative', () => {
  const rich = base({
    id: 'carscom:1', sourceId: 'carscom',
    trim: 'Coupe', series: 'I12', location: 'Portland, OR',
    imageUrl: 'https://example.invalid/a.jpg', bodyType: 'Coupe', exteriorColor: 'red',
  });
  const poor = base({ id: 'kbb:1', sourceId: 'kbb', titleStatus: 'salvage', accidentFree: false });

  const [group] = dedupe([rich, poor]);
  assert.equal(group!.members.length, 2);
  assert.equal(group!.primary.sourceId, 'carscom', 'the richer record still represents the group');
  assert.equal(group!.primary.titleStatus, 'salvage');
  assert.equal(group!.primary.accidentFree, false);
});

test('the more severe of two stated brands wins', () => {
  const a = base({ id: 'a:1', sourceId: 'a', titleStatus: 'clean', location: 'Portland, OR' });
  const b = base({ id: 'b:1', sourceId: 'b', titleStatus: 'flood' });
  assert.equal(dedupe([a, b])[0]!.primary.titleStatus, 'flood');
});

test('one member reporting an accident outweighs another reporting none', () => {
  const clean = base({ id: 'a:1', sourceId: 'a', accidentFree: true, accidents: 0, location: 'X' });
  const hit = base({ id: 'b:1', sourceId: 'b', accidentFree: false });
  const p = dedupe([clean, hit])[0]!.primary;
  assert.equal(p.accidentFree, false);
  // The zero came with the claim of being accident-free and cannot outlive it.
  assert.equal(p.accidents, null);
});

test('a lone listing is left exactly as it is', () => {
  const only = base({ id: 'a:1', accidentFree: true, accidents: 0 });
  const p = dedupe([only])[0]!.primary;
  assert.equal(p.accidents, 0);
  assert.equal(p.accidentFree, true);
});

test('an aggregator markup no longer splits a pair that share an odometer', () => {
  // Live: the same 2015 i8 at 32,090 miles was $39,999 on one site and $40,653
  // on another. A $500 price bucket put them either side of a boundary, so the
  // copy carrying FRAME_DAMAGE stopped speaking for the copy carrying nothing.
  const cheap = base({ id: 'carscom:1', sourceId: 'carscom', vin: null, price: 39999, mileage: 32090, accidentFree: false });
  const marked = base({ id: 'cargurus:1', sourceId: 'cargurus', vin: null, price: 40653, mileage: 32090, location: 'Lexington, KY' });

  const groups = dedupe([cheap, marked]);
  assert.equal(groups.length, 1, 'one car, not two');
  assert.equal(groups[0]!.primary.accidentFree, false);
});

test('two different cars that share an odometer are still two cars', () => {
  const a = base({ id: 'a:1', sourceId: 'a', vin: null, price: 40000, mileage: 32090 });
  const b = base({ id: 'b:1', sourceId: 'b', vin: null, price: 62000, mileage: 32090 });
  assert.equal(dedupe([a, b]).length, 2);
});

test('a rounded odometer is never treated as a strong match', () => {
  // "30,000 miles" is a marketing number many different cars share, so it must
  // not earn the composite key. These still group under the deliberately coarse
  // weak key, and the group has to say so rather than claim a strong match.
  const a = base({ id: 'a:1', sourceId: 'a', vin: null, price: 40000, mileage: 30000 });
  const b = base({ id: 'b:1', sourceId: 'b', vin: null, price: 40100, mileage: 30000 });
  const groups = dedupe([a, b]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.confidence, 'weak');
});

test('exact mileage earns a strong match where a rounded one does not', () => {
  const a = base({ id: 'a:1', sourceId: 'a', vin: null, price: 40000, mileage: 32090 });
  const b = base({ id: 'b:1', sourceId: 'b', vin: null, price: 40653, mileage: 32090 });
  assert.equal(dedupe([a, b])[0]!.confidence, 'strong');
});

test('a VIN match is never split by a price disagreement', () => {
  // Two sites quoting wildly different prices for one VIN is still one car.
  const a = base({ id: 'a:1', sourceId: 'a', price: 40000 });
  const b = base({ id: 'b:1', sourceId: 'b', price: 62000, titleStatus: 'salvage' });
  const groups = dedupe([a, b]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.primary.titleStatus, 'salvage');
});
