import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, parseSortSpec, percentiles, paretoLayers, type RankInput } from '../src/core/rank.js';

const car = (id: string, price: number | null, mileage: number | null, year = 2017, extra: Partial<RankInput> = {}): RankInput => ({
  id, price, mileage, year, firstSeen: '2026-09-01T00:00:00Z', ...extra,
});

test('a preset name resolves to its weighted terms', () => {
  const s = parseSortSpec('value');
  assert.deepEqual(s.terms, [{ key: 'deal', weight: 2 }, { key: 'mileage', weight: 1 }]);
});

test('an explicit blend parses, with weights', () => {
  const s = parseSortSpec('mileage:2+price');
  assert.deepEqual(s.terms, [{ key: 'mileage', weight: 2 }, { key: 'price', weight: 1 }]);
  assert.equal(s.label, 'Lowest mileage and lowest price');
});

test('a comma is accepted where a plus was meant', () => {
  assert.deepEqual(parseSortSpec('mileage,price').terms, parseSortSpec('mileage+price').terms);
});

test('an unknown key is reported and dropped, never a 400', () => {
  const s = parseSortSpec('colour+price');
  assert.deepEqual(s.ignored, ['colour']);
  assert.deepEqual(s.terms, [{ key: 'price', weight: 1 }]);
});

test('a spec of nothing but junk falls back to the default sort', () => {
  const s = parseSortSpec('banana');
  assert.deepEqual(s.terms, [{ key: 'price', weight: 1 }]);
  assert.deepEqual(s.ignored, ['banana']);
});

test('percentiles put the best value at 0 and the worst at 1', () => {
  const rows = [car('a', 10000, 5), car('b', 20000, 5), car('c', 30000, 5)];
  const p = percentiles(rows, 'price');
  assert.equal(p.byId.get('a'), 0);
  assert.equal(p.byId.get('c'), 1);
});

test('ties share a percentile, so identical cars cannot be arbitrarily separated', () => {
  const rows = [car('a', 10000, 5), car('b', 10000, 5), car('c', 30000, 5)];
  const p = percentiles(rows, 'price');
  assert.equal(p.byId.get('a'), p.byId.get('b'));
});

test('a missing value scores worst, never best', () => {
  const rows = [car('a', 10000, null), car('b', 20000, 50000)];
  const p = percentiles(rows, 'mileage');
  assert.equal(p.byId.get('a'), 1);
  assert.ok(p.missing.has('a'));
  // The whole point: an unknown-mileage car must not win a lowest-mileage sort.
  const { ranked } = rank(rows, 'mileage');
  assert.equal(ranked[0]!.row.id, 'b');
});

test('a higher-is-better dimension inverts correctly', () => {
  const rows = [car('old', 10000, 5, 2010), car('new', 10000, 5, 2024)];
  assert.equal(percentiles(rows, 'year').byId.get('new'), 0);
  assert.equal(percentiles(rows, 'age').byId.get('old'), 0);
});

test('the Pareto frontier is exactly the undominated set', () => {
  // b is beaten by a on both axes; a, c and d are each best at something.
  const rows = [
    car('a', 20000, 30000),
    car('b', 25000, 40000),
    car('c', 15000, 90000),
    car('d', 40000, 10000),
  ];
  const layers = paretoLayers(rows, ['price', 'mileage']);
  assert.equal(layers.get('a'), 1);
  assert.equal(layers.get('c'), 1);
  assert.equal(layers.get('d'), 1);
  assert.equal(layers.get('b'), 2);
});

test('a row with an unknown dimension is placed on no layer at all', () => {
  const rows = [car('a', 20000, 30000), car('x', 1, null)];
  const layers = paretoLayers(rows, ['price', 'mileage']);
  assert.equal(layers.get('x'), undefined);
  assert.equal(layers.get('a'), 1);
});

test('a one-dimensional sort computes no frontier', () => {
  const rows = [car('a', 20000, 30000), car('b', 25000, 40000)];
  assert.equal(paretoLayers(rows, ['price']).size, 0);
  assert.equal(rank(rows, 'price').frontierSize, 0);
});

test('the motivating query: lowest mileage and lowest price together', () => {
  const rows = [
    car('cheap-but-thrashed', 15000, 120000),
    car('best-of-both', 22000, 25000),
    car('dominated', 30000, 60000),
    car('pristine-but-dear', 45000, 8000),
  ];
  const { ranked, frontierSize } = rank(rows, 'mileage+price');
  const front = ranked.filter((r) => r.paretoLayer === 1).map((r) => r.row.id);
  // Every one of these is best at something, except the dominated one.
  assert.ok(front.includes('best-of-both'));
  assert.ok(front.includes('cheap-but-thrashed'));
  assert.ok(front.includes('pristine-but-dear'));
  assert.ok(!front.includes('dominated'));
  assert.equal(frontierSize, 3);
  // The dominated car is beaten on both axes by best-of-both, so it ranks last.
  assert.equal(ranked[ranked.length - 1]!.row.id, 'dominated');
  // The balanced car wins the blend outright.
  assert.equal(ranked[0]!.row.id, 'best-of-both');
});

test('deal ranking puts the furthest below sold median first, unrated last', () => {
  const rows = [
    car('a', 30000, 40000, 2017, { dealPercent: 5 }),
    car('b', 28000, 40000, 2017, { dealPercent: -20 }),
    car('unrated', 1000, 40000, 2017, { dealPercent: null }),
  ];
  const { ranked } = rank(rows, 'deal');
  assert.equal(ranked[0]!.row.id, 'b');
  assert.equal(ranked[ranked.length - 1]!.row.id, 'unrated');
  assert.deepEqual(ranked[ranked.length - 1]!.unknown, ['deal']);
});

test('every ranked row can explain its position on each dimension', () => {
  const rows = [car('a', 10000, 90000), car('b', 20000, 10000)];
  const { ranked } = rank(rows, 'mileage+price');
  const b = ranked.find((r) => r.row.id === 'b')!;
  assert.deepEqual(
    b.reasons.map((x) => [x.key, x.position, x.outOf]),
    [['mileage', 1, 2], ['price', 2, 2]],
  );
});

test('ranking is stable and total: no row is dropped or duplicated', () => {
  const rows = Array.from({ length: 200 }, (_, i) =>
    car(`r${i}`, (i * 7919) % 90000, (i * 104729) % 150000, 2010 + (i % 15)),
  );
  const first = rank(rows, 'best').ranked.map((r) => r.row.id);
  const second = rank([...rows].reverse(), 'best').ranked.map((r) => r.row.id);
  assert.equal(new Set(first).size, rows.length);
  // Input order must not change the answer.
  assert.deepEqual(first, second);
});
