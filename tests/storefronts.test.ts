import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mileageFrom, isVehicleProduct, matchesQuery, trustedMileage } from '../src/sources/storefronts.js';

/**
 * Specialist importers sell kei trucks on ordinary shop software, next to the
 * parts for them. Each of these traps came off a live catalogue.
 */

test('a Japanese odometer is converted, and a bare number is not a mileage', () => {
  // "travelled just 19,700KM" is kilometres, and storing it as miles would rank
  // the truck above ones that have genuinely done less.
  assert.equal(mileageFrom('This 2023 Toyota Pixis Truck has travelled just 19,700KM'), 12241);
  assert.equal(mileageFrom('1999 Suzuki Carry, 53,750 miles, 5-speed'), 53750);
  // A bed length or a price in the description is not a distance.
  assert.equal(mileageFrom('large 1850mm x 1350mm tray, $14,401'), null);
  assert.equal(mileageFrom(''), null);
});

test('a part titled with the truck it fits is not a truck', () => {
  // Parts name a make and a model and cost a few dollars.
  assert.equal(isVehicleProduct('Spark Plug - EFCS Engines - Daihatsu Hijet - S82P', 'Parts', 12), false);
  assert.equal(isVehicleProduct('Honda Acty Muddy Max 2" Lift Kit', '', 795), false);
  // A deposit reserves a truck without being one.
  assert.equal(isVehicleProduct('Deposit: 2025 Daihatsu Hijet - Standard - 4WD - White', 'Truck', 2500), false);
  // A model year, or a vehicle filing, is what makes it a vehicle.
  assert.equal(isVehicleProduct('2000 - Daihatsu HiJet', 'Truck', 12500), true);
  assert.equal(isVehicleProduct('Subaru Sambar Van 4WD Automatic', 'Vehicle', 8100), true);
});

test('a listing is bounded by the make, model and keywords asked for', () => {
  assert.equal(matchesQuery({ make: 'Daihatsu', models: ['Hijet'] }, 'Daihatsu', 'Hijet', '2014 Daihatsu Hijet Jumbo'), true);
  assert.equal(matchesQuery({ make: 'Daihatsu', models: ['Hijet'] }, 'BMW', '320i', '1992 BMW 320i M Package'), false);
  // A segment search matches any of the quoted phrases a buyer would type.
  assert.equal(matchesQuery({ keywords: '"kei truck"|hijet' }, null, null, '2005 Daihatsu Hijet Deck Van'), true);
  assert.equal(matchesQuery({ keywords: '"kei truck"|hijet' }, null, null, '1998 Toyota Crown Royal Saloon'), false);
});

test('a pre-order deposit named like a truck is not a truck for sale', () => {
  // Live: "2026 Daihatsu Hijet Jumbo Extra 4WD" at $2,500, flagged only by its
  // slug, would have ranked as the cheapest kei truck in the country.
  assert.equal(
    isVehicleProduct('2026 Daihatsu Hijet Jumbo Extra 4WD Red', 'Vehicle', 2500,
      'https://keitrucksmarket.com/product/coming-soon-2026-daihatsu-hijet-jumbo-extra-4wd-red/'),
    false,
  );
  assert.equal(isVehicleProduct('Pre-Order: 2025 Suzuki Carry', 'Truck', 3000), false);
  // The same truck without the pre-order marker is a listing.
  assert.equal(isVehicleProduct('2000 Suzuki Carry 4WD', 'Vehicle', 3200, 'https://jpmminitrucks.com/product/2000-suzuki-carry-4wd/'), true);
});

test('an odometer that reads the model year is not a mileage', () => {
  // Live: "Odometer reading: 2002 miles" on a 2002 Mitsubishi Minicab, because
  // the importer's template filled the odometer from the year field.
  assert.equal(trustedMileage(mileageFrom('Odometer reading: 2002 miles'), 2002), null);
  assert.equal(trustedMileage(38472, 1997), 38472);
  assert.equal(trustedMileage(null, 1997), null);
});
