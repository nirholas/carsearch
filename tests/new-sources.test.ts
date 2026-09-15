import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExoticInventory } from '../src/sources/exoticcartrader.js';
import { parseBarrettLots } from '../src/sources/barrettjackson.js';
import { goodingPrice, parseGoodingLots } from '../src/sources/goodingco.js';

test('Exotic Car Trader parses an active HTMX listing without monthly-payment confusion', () => {
  const html = `
    <div hx-get="/htmx/cfs?offset=24&amp;make=Porsche" role="listitem" class="inventory-list-item">
      <a href="/listing/2024-porsche-911-260864469">
        <img src="https://images.exoticcartrader.com/64469/passenger-white?width=800">
      </a>
      <h3 class="car-name black tops">2024 Porsche 911 Carrera GTS Cabriolet</h3>
      <div class="text-listing-price">ASK: $196,299</div>
      <div class="vehicle-mileage-thumb">Miles: 15,764</div>
      <div class="monthly-payment">Estimated: $2018.64/mo</div>
    </div>`;
  const [row] = parseExoticInventory(html);
  assert.ok(row);
  assert.equal(row.id, 'exoticcartrader:260864469');
  assert.equal(row.price, 196299);
  assert.equal(row.mileage, 15764);
  assert.equal(row.make, 'Porsche');
  assert.equal(row.model, '911');
  assert.match(row.url!, /2024-porsche-911-260864469$/);
});

test('Gooding keeps hammer and asking prices distinct and never promotes estimates', () => {
  assert.deepEqual(goodingPrice({ salePrice: '224000', askingPrice: 300000 }), { price: 224000, kind: 'sold' });
  assert.deepEqual(goodingPrice({ salePrice: null, askingPrice: 550000 }), { price: 550000, kind: 'ask' });
  assert.equal(goodingPrice({ lowEstimate: 400000, highEstimate: 500000 }), null);

  const rows = parseGoodingLots([
    {
      objectID: 'abc123', title: '2019 Porsche 991 GT2 RS Clubsport', itemType: 'Cars',
      make: 'Porsche', modelYear: 2019, model: '991 GT2 RS Clubsport', salePrice: '390000',
      currency: 'USD', slug: '2019-porsche-991-gt2-rs-clubsport-pb26',
      auctionName: 'Pebble Beach Auctions', auctionEndDate: '1786838400000',
    },
    { objectID: 'estimate', title: '1964 Porsche 904', itemType: 'Cars', lowEstimate: 1_000_000, highEstimate: 1_500_000 },
    { objectID: 'watch', title: 'Porsche dealership sign', itemType: 'Automobilia', salePrice: 900 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.price, 390000);
  assert.equal(rows[0]?.priceKind, 'sold');
  assert.equal(rows[0]?.year, 2019);
  assert.match(rows[0]?.url ?? '', /2019-porsche-991-gt2-rs-clubsport-pb26$/);
});

test('Barrett-Jackson keeps sold vehicles and rejects unsold or unpriced lots', () => {
  const rows = parseBarrettLots([
    {
      item_id: '302340', title: '2025 PORSCHE 911 GT3 RS WEISSACH', price: '495000.0000000001',
      is_sold: true, year: '2025', make: 'PORSCHE', model: '911', style: 'GT3 RS WEISSACH',
      vin: 'WP0AF2A99SS278001', event_slug: '2026-las-vegas',
      slug: '2025-porsche-911-gt3-rs-weissach', run_datetime: '2026-09-11T16:08:00',
    },
    { item_id: '2', title: '1967 Ford Mustang', price: '55000', is_sold: false },
    { item_id: '3', title: 'Porsche Dealership Sign', price: '900', is_sold: true },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.price, 495000);
  assert.equal(rows[0]?.priceKind, 'sold');
  assert.equal(rows[0]?.vin, 'WP0AF2A99SS278001');
  assert.match(rows[0]?.url ?? '', /2026-las-vegas\/docket\/vehicle\/2025-porsche-911-gt3-rs-weissach-302340$/);
});
