import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropHistory } from '../src/sources/carvana.js';

/**
 * Carvana publishes one prior price per car. It is testimony about a markdown
 * that already happened, not something this index observed, so the only thing
 * that matters is refusing to invent the timestamp it hangs on.
 */

test('a drop with a date becomes one historical point', () => {
  const h = dropHistory({ previousPrice: 30990, priceUpdateDate: '2026-09-10T00:00:00Z' });
  assert.equal(h?.length, 1);
  assert.equal(h?.[0]?.price, 30990);
  assert.match(h?.[0]?.observedAt ?? '', /^2026-09-10/);
});

test('a price with no date is discarded, not stamped with today', () => {
  // Attaching "now" to a markdown that happened at an unknown time would put a
  // false point on the curve, which is worse than a car with no history.
  assert.equal(dropHistory({ previousPrice: 30990 }), null);
  assert.equal(dropHistory({ previousPrice: 30990, priceUpdateDate: 'not a date' }), null);
});

test('a car that never dropped has no history', () => {
  assert.equal(dropHistory({}), null);
  assert.equal(dropHistory({ priceUpdateDate: '2026-09-10T00:00:00Z' }), null);
});

test('a zero or negative prior price is not a price', () => {
  assert.equal(dropHistory({ previousPrice: 0, priceUpdateDate: '2026-09-10T00:00:00Z' }), null);
  assert.equal(dropHistory({ previousPrice: -1, priceUpdateDate: '2026-09-10T00:00:00Z' }), null);
});
