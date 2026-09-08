import type { Listing } from './types.js';

/**
 * Builds a Listing from whatever an adapter actually learned.
 *
 * Adapters used to write every field of the object literal, including a long
 * tail of `null`s for things their source never publishes. That made the shape
 * of a Listing a copy-paste contract enforced by nothing, and it meant every
 * new attribute required editing every adapter to add another `null`.
 *
 * Here the defaults live once. An adapter states what it knows; everything
 * unstated is null, which is exactly the claim being made: not "no", but "this
 * source did not say".
 */

export type ListingDraft = Partial<Listing> & Pick<Listing, 'id' | 'sourceId' | 'title'>;

export function makeListing(draft: ListingDraft): Listing {
  const now = new Date().toISOString();
  return {
    sourceListingId: null,
    url: null,
    year: null,
    make: null,
    model: null,
    trim: null,
    series: null,
    vin: null,
    price: null,
    priceKind: 'ask',
    currency: 'USD',
    mileage: null,
    mileageIsRounded: false,
    location: null,
    sellerType: null,
    bodyType: null,
    exteriorColor: null,
    fuelType: null,
    eventDate: null,
    imageUrl: null,
    firstSeen: now,
    lastSeen: now,

    titleStatus: null,
    owners: null,
    accidents: null,
    accidentFree: null,
    serviceRecords: null,
    usage: null,
    isImport: null,
    openRecall: null,
    transmission: null,
    drivetrain: null,
    engine: null,
    cylinders: null,
    displacementL: null,
    doors: null,
    seats: null,
    mpgCity: null,
    mpgHighway: null,
    rangeMiles: null,
    batteryKwh: null,
    interiorColor: null,
    certified: null,
    dealerName: null,
    dealerRating: null,
    options: null,

    ...draft,
  };
}
