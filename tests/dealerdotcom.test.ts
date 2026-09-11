import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberIn, priceOf, placeOf, type DdcVehicle } from '../src/sources/dealerdotcom.js';

/**
 * These cover the three places a dealer.com record hides a value behind
 * formatting, because each one silently produced a dropped car during wiring.
 */

test('a formatted dollar amount reduces to its number', () => {
  assert.equal(numberIn('$42,934'), 42934);
  assert.equal(numberIn('8,510 miles'), 8510);
  assert.equal(numberIn('$0'), null);
  assert.equal(numberIn(null), null);
  assert.equal(numberIn('call for price'), null);
});

test('the asking price wins over retail, which is what a buyer is quoted', () => {
  const pricing: DdcVehicle['pricing'] = {
    retailPrice: '$77,791',
    dprice: [
      { label: 'Price', typeClass: 'askingPrice', value: '$77,791' },
      { label: 'Doc Fee', typeClass: 'wholesalePrice', value: '$85' },
      { label: 'Selling Price', typeClass: 'internetPrice', value: '$77,876' },
    ],
  };
  // Not the $85 doc fee, and not the fee-inclusive $77,876 total.
  assert.equal(priceOf(pricing), 77791);
});

test('retail is the fallback when no asking price is published', () => {
  assert.equal(priceOf({ retailPrice: '$20,814' }), 20814);
  assert.equal(priceOf(undefined), null);
  assert.equal(priceOf({}), null);
});

test('a car with no price at all is refused rather than stored at zero', () => {
  // Lithia under a wrong siteId returns exactly this: a full record, no pricing.
  assert.equal(priceOf({ dprice: [] }), null);
});

test('the location drops the distance marker the field carries', () => {
  const v: DdcVehicle = { attributes: [{ name: 'locationDistance', value: 'Pittsburgh, PA :::' }] };
  assert.equal(placeOf(v), 'Pittsburgh, PA');
  assert.equal(placeOf({}), null);
});
