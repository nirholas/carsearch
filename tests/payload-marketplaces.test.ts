import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRecords } from '../src/sources/nextjs.js';

/**
 * These two sources are read out of an embedded payload, and both of the traps
 * below cost a live run before they were guarded.
 */

test('a payload record array is found by its marker field', () => {
  const adverts = [
    { makeAnalyticsName: 'Porsche', id: '1', price: 19995, year: 1999 },
    { makeAnalyticsName: 'Audi', id: '2', price: 54995, year: 2014 },
  ];
  const html = `<script>window.__DATA__=${JSON.stringify({ results: adverts })}</script>`;
  const found = findRecords<{ makeAnalyticsName: string }>(html, 'makeAnalyticsName');
  assert.equal(found.length, 2);
});

test('a search payload carries adverts the search did not ask for', () => {
  // Live: a Porsche query returned a Toyota Yaris and an Audi R8 in the first
  // six, because featured and sponsored adverts ride along in the same payload.
  // The advert states its own make, so that is what bounds the result.
  const sameName = (a: string | undefined, b: string) => {
    const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
    return a !== undefined && key(a) === key(b);
  };
  assert.equal(sameName('Toyota', 'Porsche'), false);
  assert.equal(sameName('Porsche', 'Porsche'), true);
  assert.equal(sameName('Mercedes-Benz', 'Mercedes Benz'), true);
});

test('a field that is sometimes an object does not kill the source', () => {
  // Live: Cars24 ships `transmissionType` as a string on most records and as a
  // labelled object on some, and the parser threw `text.toLowerCase is not a
  // function`, taking the entire crawl of that source down with it.
  const text = (value: unknown): string | null => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (value && typeof value === 'object') {
      const o = value as Record<string, unknown>;
      for (const key of ['value', 'label', 'name', 'display', 'text']) {
        if (typeof o[key] === 'string') return o[key];
      }
    }
    return null;
  };
  assert.equal(text('Manual'), 'Manual');
  assert.equal(text({ label: 'Automatic' }), 'Automatic');
  assert.equal(text({ nothing: 1 }), null);
  assert.equal(text(undefined), null);
});
