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

/* ------------------------------------------------------- sort intent */

test('the motivating request: lowest mileage, lowest price, one specific year', () => {
  const { query, interpretation } = parseQuery('2017 porsche macan lowest mileage and cheapest');
  assert.equal(query.make, 'Porsche');
  assert.deepEqual(query.models, ['Macan']);
  assert.equal(query.yearMin, 2017);
  assert.equal(query.yearMax, 2017);
  assert.equal(query.sort, 'mileage+price');
  assert.ok(interpretation.some((l) => l.includes('nothing beats on both')));
});

test('the same request with the two halves swapped', () => {
  assert.equal(parseQuery('cheapest with lowest miles').query.sort, 'mileage+price');
});

test('"lowest mileage" is a ranking, never the "low miles" filter', () => {
  const ranked = parseQuery('macan lowest mileage');
  assert.equal(ranked.query.sort, 'mileage');
  // The filter must not fire: capping at 40,000 miles would hide most of what
  // the user asked to see ranked, and the page would still look plausible.
  assert.equal(ranked.query.mileageMax, undefined);

  const filtered = parseQuery('macan with low miles');
  assert.equal(filtered.query.mileageMax, 40000);
});

test('an explicit mileage cap still parses alongside a sort', () => {
  const { query } = parseQuery('cheapest macan under 60k miles');
  assert.equal(query.sort, 'price');
  assert.equal(query.mileageMax, 60000);
});

test('value and deal intents are distinguished', () => {
  assert.equal(parseQuery('best value macan').query.sort, 'value');
  assert.equal(parseQuery('best deal vs market').query.sort, 'deal');
});

test('recency and stale-listing intents', () => {
  assert.equal(parseQuery('newly listed 911').query.sort, 'newest');
  assert.equal(parseQuery('911 longest on the market').query.sort, 'days-on-market');
  assert.equal(parseQuery('newest year macan').query.sort, 'year');
});

test('a query with no sort intent leaves the sort unset', () => {
  assert.equal(parseQuery('porsche macan under 40k').query.sort, undefined);
});

/**
 * One spelling per make. Copart shouts, most sites title-case, a few lowercase,
 * and the column took whatever it was given: one marque arrived as three facet
 * values holding 2153, 182 and 5 cars, so filtering to the obvious one silently
 * discarded 187.
 */
test('a make is canonicalised to one spelling regardless of how a source wrote it', async () => {
  const { canonicalMake } = await import('../src/core/normalize.js');
  for (const written of ['PORSCHE', 'porsche', 'Porsche', ' Porsche ']) {
    assert.equal(canonicalMake(written), 'Porsche');
  }
  assert.equal(canonicalMake('MERCEDES-BENZ'), 'Mercedes-Benz');
  assert.equal(canonicalMake('mercedes benz'), 'Mercedes-Benz');
  assert.equal(canonicalMake('landrover'), 'Land Rover');
  assert.equal(canonicalMake('ROLLS ROYCE'), 'Rolls-Royce');
  assert.equal(canonicalMake('chevy'), 'Chevrolet');

  // A marque with no entry is still the truth about that car, so it survives
  // trimmed rather than being dropped.
  assert.equal(canonicalMake('  Hispano-Suiza '), 'Hispano-Suiza');
  assert.equal(canonicalMake(null), null);
  assert.equal(canonicalMake('   '), null);
});
