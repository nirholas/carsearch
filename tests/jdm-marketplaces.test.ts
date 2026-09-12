import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPath as jdmPath, odometerMiles, toDraft as jdmDraft } from '../src/sources/jdmbuysell.js';

const NOW = '2026-09-12T00:00:00.000Z';

test('JDMBUYSELL routes a badge to its make/model page and the segment to the kei category', () => {
  assert.equal(jdmPath({ make: 'Suzuki' }, 'Carry'), '/for-sale/suzuki/carry/');
  assert.equal(jdmPath({ make: 'Nissan' }), '/for-sale/nissan/');
  assert.equal(jdmPath({ keywords: 'kei truck' }), '/for-sale/kei-trucks/');
  assert.equal(jdmPath({ keywords: 'japanese mini truck' }), '/for-sale/kei-trucks/');
  assert.equal(jdmPath({ keywords: 'cheap sedan' }), null);
});

test('JDMBUYSELL odometers are kilometres and are converted', () => {
  assert.equal(odometerMiles({ mileageFromOdometer: { value: 75949, unitCode: 'KMT' } }), 47193);
  assert.equal(odometerMiles({ mileageFromOdometer: { value: 20000, unitCode: 'SMI' } }), 20000);
  assert.equal(odometerMiles({}), null);
});

test('a JDMBUYSELL ad becomes a listing with the seller, and never a location', () => {
  const ad = {
    '@type': ['Product', 'Vehicle'],
    name: '2001 SUZUKI CARRY 4WD EFI A/C LOT#936',
    url: 'https://www.jdmbuysell.com/ad/tokyomotorsdc-2001-suzuki-carry-11218318557220/',
    vehicleModelDate: '2001', brand: { name: 'Suzuki' }, model: 'Carry', vehicleTransmission: 'Manual',
    mileageFromOdometer: { value: 75949, unitCode: 'KMT' },
    offers: { price: 8400, priceCurrency: 'USD', availability: 'https://schema.org/InStock', seller: { name: 'Tokyo Motors DC LLC' } },
  };
  const d = jdmDraft(ad, NOW)!;
  assert.equal(d.price, 8400);
  assert.equal(d.year, 2001);
  assert.equal(d.dealerName, 'Tokyo Motors DC LLC');
  assert.equal(d.mileage, 47193);
  // The page's only address is JDMBUYSELL's own office; guessing from it put every truck in Canada.
  assert.equal(d.location, null);
  assert.equal(jdmDraft({ ...ad, offers: { ...ad.offers, availability: 'https://schema.org/SoldOut' } }, NOW), null);
});
