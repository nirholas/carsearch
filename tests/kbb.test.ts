import { test } from 'node:test';
import assert from 'node:assert/strict';
import { historyFacts, location, priceHistory, inventoryFrom, toDraft, sameMake, type KbbRecord } from '../src/sources/kbb.js';

/**
 * The history flags are the reason this source was wired, and every one of
 * these assertions is about NOT over-reading them. They are the difference
 * between a filter that narrows honestly and one that invents facts.
 */
test('ONE_OWNER is a count; NO_ONE_OWNER is not', () => {
  assert.equal(historyFacts(['ONE_OWNER']).owners, 1);
  // More than one owner, but the source never says how many. A 2 here would be
  // fabricated, and this field is filtered on.
  assert.equal(historyFacts(['NO_ONE_OWNER']).owners, null);
  assert.equal(historyFacts(undefined).owners, null);
});

test('accidents distinguishes "none reported" from "not stated"', () => {
  const clean = historyFacts(['NO_ACCIDENTS_REPORTED']);
  assert.equal(clean.accidents, 0);
  assert.equal(clean.accidentFree, true);

  const wrecked = historyFacts(['ACCIDENTS_REPORTED']);
  assert.equal(wrecked.accidentFree, false);
  // Reported, but the count is never published. Null, not 1.
  assert.equal(wrecked.accidents, null);

  const silent = historyFacts(['FREE_REPORT']);
  assert.equal(silent.accidentFree, null);
  assert.equal(silent.accidents, null);
});

test('NO_SALVAGE_TITLE never becomes a clean title', () => {
  // "Not salvage" leaves rebuilt, flood and lemon wide open. Treating a partial
  // assurance as a clean title is the mistake TitleStatus exists to prevent.
  const d = toDraft(
    { id: 1, make: { name: 'McLaren' }, vhrPreview: ['NO_SALVAGE_TITLE'] } as KbbRecord,
    '2026-09-08T00:00:00.000Z',
  );
  assert.equal(d?.titleStatus ?? null, null);
});

test('price is the advertised sticker, not the all-in price with fees', () => {
  const d = toDraft(
    {
      id: 7,
      make: { name: 'Rolls-Royce' },
      pricingDetail: { displayPrice: 456023, salePrice: 454800, preFeeDerivedPrice: 454800, kbbFppAmount: 445473 },
    } as KbbRecord,
    '2026-09-08T00:00:00.000Z',
  );
  // Comparing one source's out-the-door number against another's sticker is a
  // silent apples-to-oranges error, so the sticker wins and the other is kept.
  assert.equal(d?.price, 454800);
  assert.equal((d?.raw as Record<string, unknown>).allInPrice, 456023);
  assert.equal((d?.raw as Record<string, unknown>).kbbFairPurchasePrice, 445473);
});

test('dated price history parses, sorts, and drops "Price Today"', () => {
  const points = priceHistory({
    pricingHistory: [
      { dateUpdated: '08.04.2026', price: '$457,023' },
      { dateUpdated: '07.28.2026', price: '$459,800' },
      { dateUpdated: 'Price Today', price: '$456,023' },
    ],
  } as KbbRecord);
  // "Price Today" carries no date, and the crawler records today itself.
  assert.deepEqual(points, [
    { observedAt: '2026-07-28', price: 459800 },
    { observedAt: '2026-08-04', price: 457023 },
  ]);
  assert.equal(priceHistory({} as KbbRecord), null);
});

test('location is the tail of titleLong that title does not cover', () => {
  assert.equal(
    location({ title: 'Used 2020 McLaren 720S Performance', titleLong: 'Used 2020 McLaren 720S Performance Scottsdale AZ 85260' } as KbbRecord),
    'Scottsdale AZ 85260',
  );
  assert.equal(location({ title: 'Used 2020 McLaren 720S', titleLong: 'Used 2020 McLaren 720S' } as KbbRecord), null);
  assert.equal(location({} as KbbRecord), null);
});

test('mileage of zero or unparseable is unknown, never zero miles', () => {
  const now = '2026-09-08T00:00:00.000Z';
  assert.equal(toDraft({ id: 1, make: { name: 'Ford' }, mileage: { value: '2,960' } } as KbbRecord, now)?.mileage, 2960);
  assert.equal(toDraft({ id: 2, make: { name: 'Ford' }, mileage: { value: '--' } } as KbbRecord, now)?.mileage, null);
  assert.equal(toDraft({ id: 3, make: { name: 'Ford' } } as KbbRecord, now)?.mileage, null);
});

test('a record with no make is not inventory', () => {
  assert.equal(toDraft({ id: 4 } as KbbRecord, '2026-09-08T00:00:00.000Z'), null);
  assert.equal(toDraft({ make: { name: 'Ford' } } as KbbRecord, '2026-09-08T00:00:00.000Z'), null);
});

test('cylinders come off the engine name', () => {
  const now = '2026-09-08T00:00:00.000Z';
  assert.equal(toDraft({ id: 5, make: { name: 'McLaren' }, engine: { name: '8-Cylinder Turbo' } } as KbbRecord, now)?.cylinders, 8);
  assert.equal(toDraft({ id: 6, make: { name: 'Tesla' }, engine: { name: 'Electric' } } as KbbRecord, now)?.cylinders, null);
});

test('a page with no payload yields nothing rather than throwing', () => {
  assert.deepEqual(inventoryFrom('<html><body>blocked</body></html>'), []);
  assert.deepEqual(inventoryFrom('<script id="__NEXT_DATA__" type="application/json">{not json</script>'), []);
  const ok = inventoryFrom(
    '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({ props: { pageProps: { __eggsState: { inventory: { '1': { id: 1, make: { name: 'Audi' } } } } } } }) +
      '</script>',
  );
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.make?.name, 'Audi');
});

/**
 * The off-make guard exists because an unrecognised slug answers 200 with
 * unrelated cars. It must not fire on a make that is merely punctuated
 * differently: doing so rejects a whole correct result set and reports "slug is
 * wrong" about a slug that was right. Observed live, on Mercedes-Benz.
 */
test('the off-make guard ignores punctuation, not identity', () => {
  assert.ok(sameMake('Mercedes-Benz', 'Mercedes Benz'));
  assert.ok(sameMake('Mercedes-Benz', 'mercedes-benz'));
  assert.ok(sameMake('Land Rover', 'land-rover'));
  assert.ok(sameMake('Rolls-Royce', 'rolls royce'));

  assert.ok(!sameMake('Mercury', 'Mercedes-Benz'));
  assert.ok(!sameMake('Ford', 'Ferrari'));
  assert.ok(!sameMake(undefined, 'Ford'));
});

test('a positive title brand is read; NO_SALVAGE_TITLE is still not "clean"', () => {
  // Three live BMW i8s published SALVAGE_TITLE, and the cheapest was being
  // shown as a car whose history nobody had published.
  assert.equal(historyFacts(['SALVAGE_TITLE', 'ACCIDENTS_REPORTED']).titleStatus, 'salvage');
  // A salvage brand being absent is a narrower claim than an unbranded title,
  // and this source can be silent about every other brand in the enum.
  assert.equal(historyFacts(['NO_SALVAGE_TITLE', 'NO_ACCIDENTS_REPORTED']).titleStatus, null);
  assert.equal(historyFacts(undefined).titleStatus, null);
});

test('frame damage outranks a clean accident record', () => {
  // Live: a 2015 i8 published both flags at once, priced $6,901 under KBB fair.
  const both = historyFacts(['NO_SALVAGE_TITLE', 'FRAME_DAMAGE', 'NO_ACCIDENTS_REPORTED']);
  assert.equal(both.accidentFree, false);
  // Never zero: a damaged frame with no claim on file means nobody stated a count.
  assert.equal(both.accidents, null);
});
