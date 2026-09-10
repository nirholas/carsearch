import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSlug, parseCard, parseCards } from '../src/sources/hemmings.js';

const NOW = '2026-09-10T00:00:00.000Z';

/**
 * The place is the tail of the slug, and a fixed two-segment slice cut every
 * multi-word city: `los-angeles-ca` rendered as "Angeles Ca".
 */
test('a multi-word city survives the slug', () => {
  assert.deepEqual(parseSlug('2018-porsche-911-los-angeles-ca-127254', 'Porsche', '911'), { id: '127254', location: 'Los Angeles, CA' });
  // The model must not be dragged into the city: this once read "914 Sarasota, FL".
  assert.deepEqual(parseSlug('1975-porsche-914-sarasota-fl-940565', 'Porsche', '914'), { id: '940565', location: 'Sarasota, FL' });
  // A spelled-out region is not a state code, so it stays part of the place.
  assert.deepEqual(parseSlug('1988-porsche-911-ottowa-ontario-334432', 'Porsche', '911'), { id: '334432', location: 'Ottowa Ontario' });
  // A two-word marque is stripped whole.
  assert.deepEqual(parseSlug('1990-mercedes-benz-300sl-boca-raton-fl-551234', 'Mercedes-Benz', '300SL'), { id: '551234', location: 'Boca Raton, FL' });
  assert.deepEqual(parseSlug('no-trailing-id'), { id: null, location: null });
});

const CARD = `
  href="/listing/2002-porsche-996-laguna-beach-ca-175435"
  class="block relative"><img src="https://thumbor.hmn.com/x.jpg">
  <h3 class="font-franklin"> 2002 Porsche 996 </h3>
  <span> ASKING PRICE </span><span> $79,500 </span>`;

test('a classified is read as an asking price', () => {
  const d = parseCard(CARD, NOW)!;
  assert.equal(d.price, 79500);
  assert.equal(d.priceKind, 'ask');
  assert.equal(d.year, 2002);
  assert.equal(d.make, 'Porsche');
  assert.equal(d.url, 'https://www.hemmings.com/listing/2002-porsche-996-laguna-beach-ca-175435');
  assert.equal(d.id, 'hemmings:175435');
});

/**
 * A lot mid-auction is legitimately far below market until it closes, so a bid
 * must never join the same population as an asking price.
 */
test('a live auction is a bid, not an ask', () => {
  const d = parseCard(CARD.replace('ASKING PRICE', 'CURRENT BID').replace('/listing/', '/auction/'), NOW)!;
  assert.equal(d.priceKind, 'bid');
  assert.match(d.url!, /\/auction\//);
});

test('a card with no price is skipped rather than guessed at', () => {
  // Auctions with no bid yet publish no figure on the search page.
  assert.equal(parseCard(CARD.replace(/ASKING PRICE[\s\S]*/, ''), NOW), null);
  assert.equal(parseCard('<h3>2002 Porsche 996</h3>', NOW), null);
});

/**
 * Both traps in the real markup at once: attributes split across lines, and an
 * auction path beside a classified path. Keying on one drops half the page.
 */
test('cards are split on multi-line anchors across both path forms', () => {
  const page = `
    <a
        href="/listing/2002-porsche-996-laguna-beach-ca-175435"
        onclick="trackClick(event)"
        class="block relative rounded"><img src="https://x/1.jpg">
    <h3> 2002 Porsche 996 </h3><span>ASKING PRICE</span><span>$79,500</span>
    <a
        href="/auction/1975-porsche-914-sarasota-fl-940565"
        onclick="trackClick(event)"
        class="block relative rounded"><img src="https://x/2.jpg">
    <h3> 1975 Porsche 914 </h3><span>CURRENT BID</span><span>$31,000</span>`;
  const rows = parseCards(page, NOW);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.price), [79500, 31000]);
  // The signature of a mispairing bug is one distinct price across many rows.
  assert.equal(new Set(rows.map((r) => r.price)).size, rows.length);
});
