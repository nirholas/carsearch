import type { SourceAdapter, SearchQuery } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { findRecords } from './nextjs.js';
import { isRoundedMileage } from '../core/normalize.js';
import { canonicalFuelType, canonicalBodyType, canonicalColor } from '../core/canonical.js';
import { parseTransmission } from '../core/facets.js';

/**
 * Two marketplaces whose inventory lives in an embedded payload rather than in
 * markup or schema.org.
 *
 * Both were already recorded as reachable and neither was readable, because
 * the hard part of one of these is not fetching the page: it is knowing which
 * field marks a car among the thousands of config, analytics and routing
 * objects in the same payload. probe-payload-markers.ts answers that, and once
 * the marker is known the records are better than anything in the markup,
 * carrying the odometer, the gearbox and the owner count as typed fields.
 */

/**
 * Compares two names on alphanumerics, so "Mercedes-Benz" matches "Mercedes
 * Benz". With `prefix`, a trim of the model also matches ("i8 Coupe" against
 * "i8"), which is what a model comparison needs and a make comparison does not.
 */
function sameName(a: string | undefined | null, b: string, asModel = false): boolean {
  if (a === undefined || a === null) return false;
  const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key(a) === key(b)) return true;
  if (!asModel) return false;
  /**
   * A model is compared as a token set, not by prefix. "718 Cayman" against
   * "Cayman" leads with the generation number, so neither string starts with
   * the other, while "i3" and "i8" must still stay apart.
   */
  const tokens = (v: string) => new Set(v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return false;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

/**
 * A field these payloads sometimes ship as an object rather than a string.
 *
 * Cars24 publishes `transmissionType` as a plain string on most records and as
 * a labelled object on some, and passing the object straight to a parser threw
 * `text.toLowerCase is not a function` and killed the whole source. One
 * inconsistent field must cost that field, not the crawl.
 */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['value', 'label', 'name', 'display', 'text']) {
      if (typeof o[key] === 'string') return o[key];
    }
  }
  return null;
}

const KM_TO_MILES = 0.621371;

/** These payloads state distance in kilometres and never say so. */
function toMiles(km: number | null): number | null {
  return km === null ? null : Math.round(km * KM_TO_MILES);
}

interface PistonHeadsAdvert {
  id?: string;
  headline?: string;
  price?: number;
  year?: number;
  currencyCode?: string;
  makeAnalyticsName?: string;
  modelAnalyticsName?: string;
  isPriceOnApplication?: boolean;
  isPriceOnAuction?: boolean;
  fullSizeImageUrls?: string[];
  specificationData?: {
    bodyType?: unknown; colour?: unknown; fuelType?: unknown;
    mileage?: number; transmissionType?: unknown;
  };
}

/**
 * The UK enthusiast market. Its adverts carry a full specification block, so a
 * row arrives with the gearbox and the colour already typed rather than parsed
 * out of a headline.
 */
export const pistonheads: SourceAdapter = {
  source: getSource('pistonheads')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    const models = query.models?.length ? query.models : [undefined];

    for (const model of models) {
      const p = new URLSearchParams();
      if (query.make) p.set('m', query.make);
      if (model) p.set('ms', model);
      if (query.priceMax) p.set('max-price', String(query.priceMax));
      if (query.yearMin) p.set('min-year', String(query.yearMin));
      const url = `https://www.pistonheads.com/buy/search?${p}`;

      try {
        const res = await fetchWithTls(url);
        if (res.status !== 200) { ctx.log(`pistonheads ${model ?? 'all'} HTTP ${res.status}`); continue; }

        const adverts = findRecords<PistonHeadsAdvert>(res.body ?? '', 'makeAnalyticsName');
        let kept = 0;
        let onApplication = 0;
        let offMake = 0;

        for (const a of adverts) {
          if (!a.id || !a.headline) continue;
          /**
           * The payload carries featured and sponsored adverts alongside the
           * results, so the search parameter does not bound it: a query for
           * Porsche came back with a Toyota Yaris and an Audi R8 in the first
           * six. The advert states its own make, so that is what is trusted.
           */
          if (query.make && !sameName(a.makeAnalyticsName, query.make)) {
            offMake += 1;
            continue;
          }
          /**
           * "Price on application" and auction adverts are skipped rather than
           * recorded at zero. A missing price is not a cheap car, and this
           * index ranks on price.
           */
          if (a.isPriceOnApplication || a.isPriceOnAuction || typeof a.price !== 'number' || a.price <= 0) {
            onApplication += 1;
            continue;
          }
          const id = `pistonheads:${a.id}`;
          if (out.has(id)) continue;
          const spec = a.specificationData ?? {};
          // A UK advert states miles, not kilometres, so this one is not converted.
          const miles = typeof spec.mileage === 'number' && spec.mileage > 0 ? spec.mileage : null;

          out.set(id, {
            id,
            sourceId: 'pistonheads',
            sourceListingId: a.id,
            url: `https://www.pistonheads.com/buy/listing/${a.id}`,
            title: a.headline,
            year: typeof a.year === 'number' ? a.year : null,
            make: a.makeAnalyticsName ?? query.make ?? null,
            // "911 Carrera [996]" names the generation in brackets; the model is what precedes it.
            model: a.modelAnalyticsName?.replace(/\s*\[[^\]]*\]\s*$/, '').trim() || null,
            series: a.modelAnalyticsName?.match(/\[([^\]]+)\]/)?.[1] ?? null,
            trim: null,
            vin: null,
            price: a.price,
            priceKind: 'ask',
            currency: (a.currencyCode ?? 'GBP').toUpperCase(),
            mileage: miles,
            mileageIsRounded: isRoundedMileage(miles),
            location: null,
            sellerType: 'dealer',
            bodyType: canonicalBodyType(text(spec.bodyType)),
            exteriorColor: canonicalColor(text(spec.colour)),
            fuelType: canonicalFuelType(text(spec.fuelType)),
            transmission: parseTransmission(text(spec.transmissionType)),
            eventDate: null,
            imageUrl: a.fullSizeImageUrls?.[0] ?? null,
            firstSeen: now,
            lastSeen: now,
          });
          kept += 1;
        }
        const skipped =
          (onApplication ? `, ${onApplication} price on application` : '') +
          (offMake ? `, ${offMake} not ${query.make}` : '');
        ctx.log(`pistonheads ${(model ?? 'all').padEnd(12)} ${String(adverts.length).padStart(3)} adverts, ${kept} kept${skipped} (pool ${out.size})`);
      } catch (e) {
        ctx.log(`pistonheads ${model ?? 'all'} FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    return [...out.values()].map(makeListing);
  },
};

interface Cars24Listing {
  appointmentId?: string;
  carName?: unknown;
  listingPrice?: number;
  originalPrice?: number;
  odometer?: { value?: number };
  year?: number;
  make?: unknown;
  model?: unknown;
  variant?: unknown;
  ownership?: number;
  fuelType?: unknown;
  bodyType?: unknown;
  transmissionType?: unknown;
  cdpRelativeUrl?: string;
  listingImage?: { uri?: string };
  address?: unknown;
}

/** India's largest used-car retailer. Odometers are kilometres. */
export const cars24: SourceAdapter = {
  source: getSource('cars24')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
    const wantedModel = query.models?.[0];
    const url = query.make
      ? `https://www.cars24.com/buy-used-${slug(query.make)}-cars/`
      : 'https://www.cars24.com/buy-used-cars/';

    try {
      const res = await fetchWithTls(url);
      if (res.status !== 200) {
        ctx.log(`cars24 HTTP ${res.status}`);
        return [];
      }

      const rows = findRecords<Cars24Listing>(res.body ?? '', 'odometer');
      let kept = 0;
      let converted = 0;
      let offModel = 0;

      for (const r of rows) {
        const carName = text(r.carName);
        if (!r.appointmentId || !carName || typeof r.listingPrice !== 'number') continue;
        /**
         * The URL addresses a make and nothing narrower, so a model query gets
         * the make's whole catalogue back: a search for a BMW i8 returned
         * twenty cars, six X3s and four X5s among them, every one a real BMW
         * and none of them the car asked for. The record states its own model.
         */
        if (wantedModel && !sameName(text(r.model) ?? carName, wantedModel, true)) {
          offModel += 1;
          continue;
        }
        const id = `cars24:${r.appointmentId}`;
        if (out.has(id)) continue;
        const km = typeof r.odometer?.value === 'number' ? r.odometer.value : null;
        const miles = toMiles(km);
        if (km !== null) converted += 1;

        out.set(id, {
          id,
          sourceId: 'cars24',
          sourceListingId: r.appointmentId,
          // The payload publishes the real listing path; a search link would not
          // find one car among thousands.
          url: r.cdpRelativeUrl
            ? `https://www.cars24.com${r.cdpRelativeUrl.startsWith('/') ? '' : '/'}${r.cdpRelativeUrl}`
            : url,
          title: [r.year, carName, text(r.variant)].filter(Boolean).join(' '),
          year: typeof r.year === 'number' ? r.year : null,
          make: text(r.make) ?? query.make ?? null,
          model: text(r.model) ?? null,
          trim: text(r.variant),
          series: null,
          vin: null,
          price: r.listingPrice,
          priceKind: 'ask',
          currency: 'INR',
          mileage: miles,
          mileageIsRounded: isRoundedMileage(miles),
          location: text(r.address),
          sellerType: 'dealer',
          // `ownership` is the ordinal of the current keeper, so 1 means one owner.
          owners: typeof r.ownership === 'number' && r.ownership > 0 ? r.ownership : null,
          bodyType: canonicalBodyType(text(r.bodyType)),
          fuelType: canonicalFuelType(text(r.fuelType)),
          transmission: parseTransmission(text(r.transmissionType)),
          eventDate: null,
          imageUrl: text(r.listingImage?.uri),
          firstSeen: now,
          lastSeen: now,
        });
        kept += 1;
      }
      const skipped = offModel ? `, ${offModel} not ${wantedModel}` : '';
      ctx.log(`cars24 ${String(rows.length).padStart(3)} records, ${kept} kept${skipped}, ${converted} kilometre readings converted`);
    } catch (e) {
      ctx.log(`cars24 FAILED: ${(e as Error).message.split('\n')[0]}`);
    }

    return [...out.values()].map(makeListing);
  },
};
