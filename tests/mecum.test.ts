import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVehicle, odometerMiles } from '../src/sources/mecum.js';

/**
 * Mecum sells cars and memorabilia from one catalogue and titles both the same
 * way, and it reports every custom field as a string.
 */

test('memorabilia titled like a car is not a car', () => {
  // "2014 Porsche Single-Sided Plastic Lighted Sign" sold for $960 and parses
  // cleanly as a 2014 Porsche, which would drag a Porsche median down.
  assert.equal(
    isVehicle({ title: '2014 Porsche Single-Sided Plastic Lighted Sign', makes: { nodes: [] } }),
    false,
  );
  // A lot filed under no make is not a vehicle even when nothing in its title
  // gives it away.
  assert.equal(isVehicle({ title: '1967 Dealership Banner', makes: { nodes: [] } }), false);
  assert.equal(
    isVehicle({ title: '1973 Porsche 911S Coupe', makes: { nodes: [{ name: 'Porsche' }] } }),
    true,
  );
});

test('a kilometre odometer is converted and a mile one is not', () => {
  assert.equal(odometerMiles({ odometer: '49234', odometerUnits: 'M' }), 49234);
  assert.equal(odometerMiles({ odometer: '20900', odometerUnits: 'K' }), 12987);
  // WPGraphQL reports an absent field as an empty string, never as null.
  assert.equal(odometerMiles({ odometer: '', odometerUnits: 'M' }), null);
  assert.equal(odometerMiles({}), null);
});
