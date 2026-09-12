import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, cardMileage } from '../src/sources/fourbie.js';

/** Fourbie Exchange is read from its listing cards, so the card shape is the contract. */

const card = (over: { title?: string; price?: string; location?: string; description?: string; seller?: string } = {}) => `
  <div class="vert-card card listingCard position-relative overflow-hidden h-100">
    <a href="https://fourbieexchange.com/listing/2000-subaru-sambar-fire-van" class="text-decoration-none">
      <img src="/storage/uploads/7846/2000-subaru-sambar-fire-van-1.jpg" class="card-img-top">
      <h4 class="mb-0 fw-bold listingCard__price"> ${over.price ?? '$13,500'} </h4>
      <span class="text-muted small text-end listingCard__location text-uppercase"> ${over.location ?? 'Sacramento, CA'} </span>
      <h5 class="card-title mb-2 fw-bold text-uppercase listingCard__title"> ${over.title ?? '2000 Subaru Sambar Fire Van'} </h5>
      <p class="card-text text-muted mb-2 listingCard__description"> ${over.description ?? '11K mi, EN07 658 cc Inline-4 Cylinder, Manual, 4&#215;4'} </p>
    </a>
    <div class="seller-type"><span class="listingCard__sellerMeta"><a href="https://fourbieexchange.com/seller/vans-from-japan" class="listingCard__badge">${over.seller ?? 'VANS FROM JAPAN'}</a></span></div>
  </div>`;

test('a card yields its title, price, location, link and image', () => {
  const [c] = parseCards(card());
  assert.ok(c);
  assert.equal(c.title, '2000 Subaru Sambar Fire Van');
  assert.equal(c.price, 13500);
  assert.equal(c.location, 'Sacramento, CA');
  assert.equal(c.url, 'https://fourbieexchange.com/listing/2000-subaru-sambar-fire-van');
  assert.equal(c.image, 'https://fourbieexchange.com/storage/uploads/7846/2000-subaru-sambar-fire-van-1.jpg');
  assert.equal(c.privateParty, false);
});

test('a card without a price is kept apart, not read as free', () => {
  const [c] = parseCards(card({ price: 'Call for price' }));
  assert.equal(c?.price, null);
});

test('two cards never bleed into each other', () => {
  const cards = parseCards(card() + card({ title: '1997 Honda Acty HA3', price: '$7,900', location: 'Portland, OR' }));
  assert.equal(cards.length, 2);
  assert.equal(cards[1]?.title, '1997 Honda Acty HA3');
  assert.equal(cards[1]?.location, 'Portland, OR');
});

test('"11K mi" is eleven thousand miles, not eleven', () => {
  assert.equal(cardMileage('11K mi, EN07 658 cc Inline-4 Cylinder, Manual'), 11000);
  assert.equal(cardMileage('20k km, automatic'), 12427);
  assert.equal(cardMileage('53,750 miles'), 53750);
  assert.equal(cardMileage('Manual, 4x4'), null);
});
