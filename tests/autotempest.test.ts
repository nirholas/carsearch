import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attribute, hostOf, ORIGIN_HOSTS, BACKEND_SITE_CODES } from '../src/sources/autotempest.js';

/**
 * Attribution decides which site a buyer is sent to, and the id every listing
 * is stored under. Getting it wrong is not cosmetic: it puts one car in the
 * index twice and links the buyer to a page the car is not on.
 */
test('the destination host overrules a disagreeing tile code', () => {
  // The live defect: 49 rows carrying the CarMax code linked to cars.com.
  assert.equal(attribute('https://www.cars.com/vehicledetail/2e93350a/', 'cm'), 'carscom');
});

test('the code stands when it agrees with the host', () => {
  assert.equal(attribute('https://www.carmax.com/cars?search=WP1AA2A52KLB01337', 'cm'), 'carmax');
});

test('an unmapped host falls back to the code', () => {
  assert.equal(attribute('https://example.invalid/listing/1', 'cgu'), 'cargurus');
});

test('an origin nobody has mapped stays visible rather than crediting the aggregator', () => {
  // Live crawls surfaced `abt`, a code not in the table. It must not silently
  // become an AutoTempest listing, because then nobody ever maps it.
  assert.equal(attribute('https://example.invalid/listing/1', 'abt'), 'autotempest:abt');
  assert.equal(attribute(null, null), 'autotempest');
});

test('hostOf drops www and survives a malformed url', () => {
  assert.equal(hostOf('https://WWW.Cars.com/x'), 'cars.com');
  assert.equal(hostOf('not a url'), null);
  assert.equal(hostOf(null), null);
});

test('every tile code has a host that resolves back to the same source', () => {
  // A code and a host that disagree about one site would reintroduce the
  // split-identity bug from the other direction.
  const byId = new Set(Object.values(ORIGIN_HOSTS));
  for (const id of Object.values(BACKEND_SITE_CODES)) {
    assert.ok(byId.has(id), `no host maps to ${id}`);
  }
});
