import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unknownQueryKeys, suggestKey } from '../src/store/filter.js';
import { dedupe } from '../src/core/dedupe.js';
import { makeListing } from '../src/core/listing.js';

const RESERVED = ['make', 'model', 'year', 'price', 'mileage', 'bodyType', 'fuelType', 'currency'];
const CONTROLS = ['limit', 'offset', 'sort', 'q', 'priceKinds', 'sources', 'yearMin', 'yearMax', 'priceMin', 'priceMax', 'mileageMax'];

/**
 * A filter that vanishes is worse than one that fails, because the caller
 * believes the answer. `models=Macan` (the parameter is `model`) was dropped in
 * silence and the search returned Panameras, Cayennes and a 911, every one of
 * them presented as a Macan.
 */
test('a mistyped filter is refused, not silently dropped', () => {
  assert.deepEqual(unknownQueryKeys({ models: 'Macan' }, RESERVED, CONTROLS), ['models']);
  assert.equal(suggestKey('models', RESERVED, CONTROLS), 'model');
});

test('every parameter the search endpoint really accepts is allowed through', () => {
  const real = {
    make: 'Porsche', model: 'Macan', yearMin: '2019', mileageMax: '60000', priceMax: '30000',
    sort: 'mileage+price', limit: '40', offset: '0', priceKinds: 'ask', sources: 'kbb', currency: 'USD',
  };
  assert.deepEqual(unknownQueryKeys(real, RESERVED, CONTROLS), []);
});

test('facet keys and their modifiers are not mistaken for typos', () => {
  const q = { titleStatus: 'clean', 'owners.max': '1', 'accidents.min': '0', 'transmission.unknown': '1' };
  assert.deepEqual(unknownQueryKeys(q, RESERVED, CONTROLS), []);
});

test('a genuinely unrelated key gets no confident suggestion', () => {
  assert.equal(suggestKey('spaceship', RESERVED, CONTROLS), null);
  // Short keys get a tighter budget: two edits on four letters is another word.
  assert.equal(suggestKey('zzzz', RESERVED, CONTROLS), null);
});

test('an empty value is not a parameter at all', () => {
  assert.deepEqual(unknownQueryKeys({ nonsense: '' }, RESERVED, CONTROLS), []);
});

/**
 * The real pair, from production. Same year, model, price and odometer; the
 * only difference is that CarMax publishes a VIN and CarGurus does not. Matching
 * by VIN first used to remove the CarMax row from every later pass, so the two
 * could never meet and a buyer saw one car twice.
 */
test('a VIN-bearing listing absorbs its VIN-less duplicate', () => {
  const base = { make: 'Porsche', model: 'Macan', year: 2019, price: 27998, mileage: 53929, mileageIsRounded: false } as const;
  const groups = dedupe([
    makeListing({ id: 'carmax:1', sourceId: 'carmax', title: '2019 Porsche Macan', vin: 'WP1AA2A52KLB01337', ...base }),
    makeListing({ id: 'cargurus:1', sourceId: 'cargurus', title: '2019 Porsche Macan', ...base }),
  ]);
  assert.equal(groups.length, 1, 'one car, listed twice');
  assert.equal(groups[0]!.members.length, 2);
  assert.equal(groups[0]!.confidence, 'exact', 'the VIN group keeps its confidence rather than being demoted');
});

test('two genuinely different cars are not merged by the alias path', () => {
  const groups = dedupe([
    makeListing({ id: 'a', sourceId: 'carmax', title: '2019 Porsche Macan', vin: 'WP1AA2A52KLB01337', make: 'Porsche', model: 'Macan', year: 2019, price: 27998, mileage: 53929, mileageIsRounded: false }),
    makeListing({ id: 'b', sourceId: 'cargurus', title: '2019 Porsche Macan', make: 'Porsche', model: 'Macan', year: 2019, price: 27998, mileage: 21000, mileageIsRounded: false }),
  ]);
  assert.equal(groups.length, 2, 'a 32,000 mile difference is a different car');
});
