import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocation, advertisedPrice } from '../src/sources/carscommerce.js';

/**
 * Dealer Inspire storefronts all answer one Cars Commerce endpoint, and the
 * feed's shape is the dealer's own rather than a rendering of it.
 */

test('the dealer address yields a city, not a street or a phone number', () => {
  // "411 E DAILY DR<br/>Camarillo, CA 93010<br/>(805) 482-8878"
  assert.equal(
    parseLocation('411 E DAILY DR<br/>Camarillo, CA 93010<br/>(805) 482-8878'),
    'Camarillo, CA 93010',
  );
  assert.equal(parseLocation('548 E 1000 S<br/>American Fork, UT 84003<br/>(801) 756-3546'), 'American Fork, UT 84003');
  // A single-line address is still better than nothing.
  assert.equal(parseLocation('Salt Lake City, UT'), 'Salt Lake City, UT');
  assert.equal(parseLocation(undefined), null);
});

test('the sticker on a new car is never used as a used car price', () => {
  // msrp is present on these records and is not what anybody pays for a used
  // car, so it is not a fallback.
  assert.equal(advertisedPrice({ our_price: 47933, price: 47933, msrp: 60115 }), 47933);
  assert.equal(advertisedPrice({ msrp: 60115 }), null);
  assert.equal(advertisedPrice({ our_price: 0, internet_price: 38871 }), 38871);
  assert.equal(advertisedPrice(undefined), null);
});
