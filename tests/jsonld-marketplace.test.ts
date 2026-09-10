import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonLd, vehicleNodes } from '../src/sources/jsonld.js';

/**
 * The two failures that kept four live marketplaces reporting almost nothing.
 */

test('bare Vehicle nodes are read, not only ItemList entries', () => {
  // Car & Classic publishes 57 priced cars this way and reported zero.
  const html = `<script type="application/ld+json">
    {"@type":"Vehicle","name":"1987 Porsche 928 S4","offers":{"@type":"Offer","price":"24500.00"}}
  </script>`;
  assert.equal(vehicleNodes(extractJsonLd(html)).length, 1);
});

test('a lower-case @type still counts as a car', () => {
  // ClassicCars.com types its entries "car", which schema.org does not define.
  const html = `<script type="application/ld+json">
    {"@type":"car","name":"1957 Porsche 356","offers":{"price":"74500"}}
  </script>`;
  assert.equal(vehicleNodes(extractJsonLd(html)).length, 1);
});

test('a car in a list and again at the top level is yielded once', () => {
  const node = '{"@type":"Car","name":"911","offers":{"price":"1"}}';
  const html = `<script type="application/ld+json">
    {"@type":"ItemList","itemListElement":[${node}]}
  </script>`;
  assert.equal(vehicleNodes(extractJsonLd(html)).length, 1);
});

test('listings whose urls share a long prefix get different ids', async () => {
  // The id was base64 of the url truncated to 44 chars, which encodes only the
  // first 33 bytes. Every Car & Classic url shares a 32-char prefix, so 57 cars
  // collapsed into 2 ids and the adapter reported "59 items, 2 kept".
  const { createHash } = await import('node:crypto');
  const fingerprint = (key: string) => createHash('sha1').update(key).digest('base64url').slice(0, 22);
  const a = 'https://www.carandclassic.com/l/C2188084';
  const b = 'https://www.carandclassic.com/l/C2071947';
  assert.notEqual(fingerprint(a), fingerprint(b));
  assert.equal(fingerprint(a), fingerprint(a), 'and the same key is stable');
});
