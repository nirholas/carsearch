import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWanted, normalizeUse, type CarmaxItem } from '../src/sources/carmax.js';

/**
 * The failure this adapter was rewritten for was invisible: it returned real
 * Porsches, just 44 of the 155 that existed, and the 111 it dropped were the
 * cheap ones. These guard the two checks that keep a short answer from looking
 * like a complete one.
 */

const car = (over: Partial<CarmaxItem> = {}): CarmaxItem => ({
  make: 'Porsche', model: 'Macan', year: 2020, basePrice: 30000, mileage: 40000, ...over,
});

test('a car of the wrong make never survives, however plausible', () => {
  // ?make=&model= returns all 58,805 CarMax cars with the filter ignored, and
  // the first one was a Ford Mustang. Every downstream check would pass it.
  assert.equal(isWanted(car({ make: 'Ford', model: 'Mustang' }), 'Porsche', 'Macan'), false);
});

test('a make slug with no stock returns the make general inventory', () => {
  // A live bmw/i8 search once returned 44 cars, all X3, X5, Z4 or 330i.
  assert.equal(isWanted(car({ make: 'BMW', model: 'X5' }), 'BMW', 'i8'), false);
  assert.equal(isWanted(car({ make: 'BMW', model: 'i3' }), 'BMW', 'i8'), false);
  assert.equal(isWanted(car({ make: 'BMW', model: 'i8' }), 'BMW', 'i8'), true);
});

test('a trim variant still matches the model it belongs to', () => {
  assert.equal(isWanted(car({ model: 'Macan S' }), 'Porsche', 'Macan'), true);
  assert.equal(isWanted(car({ model: 'Macan' }), 'Porsche', 'Macan'), true);
});

test('punctuation and case never decide a match', () => {
  assert.equal(isWanted(car({ make: 'MERCEDES-BENZ', model: 'C-Class' }), 'Mercedes Benz', 'C Class'), true);
});

test('a query with no model keeps the whole make', () => {
  assert.equal(isWanted(car({ model: 'Cayenne' }), 'Porsche', null), true);
});

test('prior use is history, never a title brand', () => {
  assert.equal(normalizeUse(['Previous Rental']), 'rental');
  assert.equal(normalizeUse(['Fleet Vehicle']), 'fleet');
  assert.equal(normalizeUse(['Personal Use']), 'personal');
  // Absent means unknown, not clean.
  assert.equal(normalizeUse(undefined), null);
  assert.equal(normalizeUse([]), null);
});
