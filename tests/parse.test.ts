import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/nl/parse.js';

const THIS_YEAR = new Date().getFullYear();

test('the motivating example: an old g wagon', () => {
  const { query, interpretation } = parseQuery('i want to find an old g wagon');
  assert.equal(query.make, 'Mercedes-Benz');
  assert.deepEqual(query.models, ['G-Class']);
  assert.equal(query.yearMax, THIS_YEAR - 15);
  // The reinterpretation of "old" must be visible, never silent.
  assert.ok(interpretation.some((l) => l.includes('"old"')));
});

test('make, model and budget', () => {
  const { query } = parseQuery('porsche macan under 40k');
  assert.equal(query.make, 'Porsche');
  assert.deepEqual(query.models, ['Macan']);
  assert.equal(query.priceMax, 40000);
});

test('a bare number in a price context means thousands', () => {
  assert.equal(parseQuery('civic under 20').query.priceMax, 20000);
  assert.equal(parseQuery('civic under 20000').query.priceMax, 20000);
  assert.equal(parseQuery('civic under 20k').query.priceMax, 20000);
});

test('mileage is not mistaken for price', () => {
  const { query } = parseQuery('tacoma under 60k miles');
  assert.equal(query.mileageMax, 60000);
  assert.equal(query.priceMax, undefined);
});

test('price and mileage together', () => {
  const { query } = parseQuery('4runner under 35k with under 80k miles');
  assert.equal(query.priceMax, 35000);
  assert.equal(query.mileageMax, 80000);
});

test('year ranges and open-ended years', () => {
  assert.deepEqual(
    [parseQuery('miata 2015-2020').query.yearMin, parseQuery('miata 2015-2020').query.yearMax],
    [2015, 2020],
  );
  assert.equal(parseQuery('wrangler 2019 or newer').query.yearMin, 2019);
  assert.equal(parseQuery('mustang 1969 or older').query.yearMax, 1969);
});

test('asking for what something sold for switches to completed sales', () => {
  const { query } = parseQuery('what did a 2017 macan sell for');
  assert.deepEqual(query.priceKinds, ['sold']);
  assert.equal(query.yearMin, 2017);
});

test('body style and fuel', () => {
  const { query } = parseQuery('electric suv under 50k');
  assert.equal(query.fuelType, 'Electric');
  assert.equal(query.bodyType, 'SUV');
  assert.equal(query.priceMax, 50000);
});

test('nicknames resolve to catalogue names', () => {
  assert.equal(parseQuery('cheap vette').query.make, 'Chevrolet');
  assert.deepEqual(parseQuery('cheap vette').query.models, ['Corvette']);
  assert.equal(parseQuery('bimmer wagon').query.make, 'BMW');
});

test('an unrecognized query reports low confidence rather than inventing constraints', () => {
  const r = parseQuery('something fun to drive');
  assert.equal(r.confident, false);
  assert.equal(r.query.make, undefined);
});

test('a zip code becomes a location, not a year or a price', () => {
  const { query } = parseQuery('civic near 92101');
  assert.equal(query.zip, '92101');
  assert.equal(query.yearMin, undefined);
  assert.equal(query.priceMax, undefined);
});

test('understood words never leak into the keyword filter', () => {
  // A keyword becomes a title LIKE in SQL, so a stray word from the question
  // does not rank results badly, it removes all of them.
  for (const q of [
    'i want to find an old g wagon',
    'what did a 2017 macan sell for',
    'cheap electric suv near 92101',
    'porsche macan under 40k with low miles',
    'show me a newer wrangler',
  ]) {
    const { query } = parseQuery(q);
    assert.equal(query.keywords, undefined, `"${q}" leaked keywords: ${query.keywords}`);
  }
});

test('a genuinely unmatched requirement is kept as a keyword', () => {
  const { query } = parseQuery('porsche macan with a panoramic sunroof');
  assert.ok(query.keywords?.includes('panoramic'));
});
