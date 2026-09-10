import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModel } from '../src/sources/carmax.js';

const car = (model?: string, name = '') => ({ '@type': 'Car', model, name });

/**
 * A model slug CarMax holds no stock for still answers 200, with the make's
 * general inventory. Filtering on brand alone let 44 X3s, X5s and Z4s through
 * a search for an i8, and every one of them survived downstream because every
 * one of them really is a BMW.
 */
test('the make inventory a stockless slug returns is rejected', () => {
  assert.equal(isModel(car('X3'), 'i8'), false);
  assert.equal(isModel(car('Z4'), 'i8'), false);
  assert.equal(isModel(car('330 Plug In Hybrid'), 'i8'), false);
});

test('two models one character apart are never confused', () => {
  assert.equal(isModel(car('i3'), 'i8'), false);
  assert.equal(isModel(car('i8'), 'i8'), true);
});

test('a trim of the requested model is kept', () => {
  assert.equal(isModel(car('Macan S'), 'macan'), true);
  assert.equal(isModel(car('Macan Electric'), 'Macan'), true);
});

test('the name is read only when the record states no model', () => {
  assert.equal(isModel(car(undefined, '2019 BMW i8 Roadster'), 'i8'), true);
  // A record with no model at all must not be assumed to be the one asked for.
  assert.equal(isModel(car(undefined, '2019 BMW X3 xDrive30i'), 'i8'), false);
});
