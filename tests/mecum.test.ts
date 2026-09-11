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

test('a body panel sold by an auction house is not a car', async () => {
  const { isNonVehicle } = await import('../src/core/normalize.js');
  // Live, from RM Sotheby's: "Porsche 911 Carrera 2 Coupe (Type 964) Front
  // Clip" sold for $549 and parsed as a 911, which would drag a 911 median
  // through the floor. A panel is titled exactly like the car it came off.
  assert.equal(isNonVehicle('Porsche 911 Carrera 2 Coupe (Type 964) Front Clip'), true);
  assert.equal(isNonVehicle('1973 Porsche 911 Body Shell'), true);
  assert.equal(isNonVehicle('Porsche 356 Rolling Shell'), true);
  // A project car is still a car, however cheap it went.
  assert.equal(isNonVehicle('1970 Porsche 914'), false);
  assert.equal(isNonVehicle('1966 Porsche 912 Coupe by Karmann'), false);
});
