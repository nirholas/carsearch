import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrim, resolveTrim } from '../src/core/trim.js';

/**
 * Trim exists to make a cohort honest, so the failures that matter are the two
 * that corrupt a cohort: reading a higher trim as the cheaper one inside it,
 * and reading bodywork as a variant.
 */

test('a longer trim always beats the shorter one inside it', () => {
  assert.equal(parseTrim('2021 Porsche 911 Turbo S', 'Porsche', '911'), 'Turbo S');
  assert.equal(parseTrim('2021 Porsche 911 Turbo', 'Porsche', '911'), 'Turbo');
  assert.equal(parseTrim('2023 Porsche 718 Cayman GT4 RS', 'Porsche', '718 Cayman'), 'GT4 RS');
  assert.equal(parseTrim('2016 Porsche Cayman GT4', 'Porsche', 'Cayman'), 'GT4');
  assert.equal(parseTrim('2020 Porsche 911 Carrera 4S', 'Porsche', '911'), 'Carrera 4S');
  // "Carrera 4S" contains "Carrera", "4S" and "S". Losing to any of them merges
  // a $150k car into a $95k cohort.
  assert.notEqual(parseTrim('2020 Porsche 911 Carrera 4S', 'Porsche', '911'), 'S');
});

test('body style, door count and drivetrain are not trims', () => {
  assert.equal(parseTrim('2017 Porsche 718 Boxster Roadster 2D', 'Porsche', '718 Boxster'), null);
  assert.equal(parseTrim('2016 Porsche Macan Sport Utility 4D', 'Porsche', 'Macan'), null);
  assert.equal(parseTrim('2021 Porsche Taycan Sedan 4D', 'Porsche', 'Taycan'), null);
  assert.equal(parseTrim('2020 Audi R8 quattro Coupe', 'Audi', 'R8'), null);
});

test('the model is stripped even when the title repeats it', () => {
  // "2017 Porsche Macan Macan S" would otherwise read the second "Macan".
  assert.equal(parseTrim('2017 Porsche Macan Macan S', 'Porsche', 'Macan'), 'S');
  // A multi-word model must not leave a stray token behind.
  assert.equal(parseTrim('2018 Porsche 718 Cayman GTS', 'Porsche', '718 Cayman'), 'GTS');
});

test('the make is inferred from the model when the row does not state one', () => {
  // The cohort that motivated this file is entirely make-null, so this path is
  // not an edge case: it is where the parser earns its keep.
  assert.equal(parseTrim('2016 Cayman 981 GT4', null, 'Cayman'), 'GT4');
  assert.equal(parseTrim('2016 Boxster 981 Black Edition', null, 'Boxster'), 'Black Edition');
  assert.equal(parseTrim('2016 Cayman 981 S', null, 'Cayman'), 'S');
});

test('an unknown make yields no trim rather than a borrowed one', () => {
  // "S" means something in four of these tables. Guessing which is worse than
  // returning nothing, because a wrong trim splits a cohort.
  assert.equal(parseTrim('2019 Koenigsegg Jesko S', null, 'Jesko'), null);
});

test('an unrecognised variant is null, not a guess', () => {
  assert.equal(parseTrim('2016 Porsche Cayman', 'Porsche', 'Cayman'), null);
  assert.equal(parseTrim('2016 Porsche Cayman Wombat Edition', 'Porsche', 'Cayman'), null);
});

test('a trim is matched on a word boundary, never inside another word', () => {
  // "Spyder" must not be found inside a colour or a dealer name, and "S" must
  // never match the S in "Sport".
  assert.equal(parseTrim('2018 Porsche Macan Sport Utility', 'Porsche', 'Macan'), null);
});

test('resolveTrim prefers what the source stated', () => {
  assert.equal(resolveTrim('2016 Cayman 981 GT4', 'Porsche', 'Cayman', 'GTS'), 'GTS');
  assert.equal(resolveTrim('2016 Cayman 981 GT4', 'Porsche', 'Cayman', null), 'GT4');
  assert.equal(resolveTrim('2016 Cayman 981 GT4', 'Porsche', 'Cayman', '   '), 'GT4');
});

test('resolveTrim discards a stated "Base"', () => {
  // Base is the absence of a trim spelled as a word. Keeping it would split the
  // base cars that carry null from the base cars that carry the string, which
  // are the same vehicle.
  assert.equal(resolveTrim('2018 Porsche 718 Cayman Base', 'Porsche', '718 Cayman', 'Base'), null);
  assert.equal(resolveTrim('2018 Porsche 718 Cayman Base', 'Porsche', '718 Cayman', 'base'), null);
});

test('Chevrolet package codes do not become the trim', () => {
  // "w/2LT" is an options package, not a variant, and it is on hundreds of rows.
  assert.equal(parseTrim('2023 Chevrolet Corvette Stingray w/2LT', 'Chevrolet', 'Corvette'), 'Stingray');
  assert.equal(parseTrim('2021 Chevrolet Corvette Z06', 'Chevrolet', 'Corvette'), 'Z06');
});
