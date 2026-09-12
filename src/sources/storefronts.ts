import type { SourceAdapter, SearchQuery, Listing } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { parseYear, parseMake, parseModel, isRoundedMileage, isNonVehicle } from '../core/normalize.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';
import { canonicalColor, canonicalBodyType } from '../core/canonical.js';

/**
 * Specialist sellers on commodity shop software: Shopify and WooCommerce.
 *
 * Kei trucks are a segment where most of the supply never reaches a car
 * marketplace. It is sold by importers running an ordinary online shop, the
 * same software that sells t-shirts, and those shops sit next to the parts and
 * bed covers the same importer sells. That turns out to be the easy case rather
 * than the hard one: both platforms publish every store's catalogue as JSON at a
 * fixed path (Shopify at /products.json, WooCommerce at
 * /wp-json/wc/store/v1/products), so one adapter per platform reads every shop
 * on it, and the work is telling a truck from a spark plug.
 */

export interface StorefrontSpec {
  /** Registry id. */
  id: string;
  /** Shop origin, e.g. https://www.kei-trucks.com */
  host: string;
  /** Where the stock physically is, as a buyer would want it stated. */
  location: string;
  currency?: string;
}

const KM_TO_MILES = 0.621371;

/**
 * Mileage from free text, in miles.
 *
 * These listings are written by importers and quote whichever unit the car was
 * sold under: "travelled just 19,700KM" is a Japanese odometer and must not be
 * stored as 19,700 miles, which would rank it far above cars that have genuinely
 * done fewer. The unit is required, because a bare number in a product
 * description is as often a price or a bed length as a distance.
 */
export function mileageFrom(text: string): number | null {
  const m = text.match(/(\d{1,3}(?:[,.]\d{3})+|\d{3,6})\s*(km|kms|kilomet\w*|mi\b|miles?)/i);
  if (!m) return null;
  const value = Number(m[1]!.replace(/[,.]/g, ''));
  if (!Number.isFinite(value) || value <= 0) return null;
  return /^k/i.test(m[2]!) ? Math.round(value * KM_TO_MILES) : value;
}

/**
 * Whether a shop product is a vehicle rather than a part or a deposit.
 *
 * An importer's catalogue is mostly parts, and parts are titled with the truck
 * they fit: "Spark Plug - EFCS Engines - Daihatsu Hijet" names a make and a
 * model and is a four dollar consumable. So a product is a vehicle only when it
 * states a model year or is filed as a vehicle, never merely because it names
 * one; and a deposit, which reserves a truck without being one, is excluded
 * outright along with anything the shared non-vehicle phrase list catches.
 */
export function isVehicleProduct(title: string, type: string, price: number | null, url = ''): boolean {
  if (/\bdeposit\b|\breservation\b|\bgift card\b/i.test(title)) return false;
  /**
   * A pre-order is a deposit wearing a truck's name. One shop lists "2026
   * Daihatsu Hijet Jumbo Extra 4WD" at $2,500, which is the deposit on a new
   * truck that has not been built, and says so only in the product slug
   * (coming-soon-2026-daihatsu-hijet-...). Stored as a listing it ranks as the
   * cheapest kei truck in America, and a new one is not road-registrable here in
   * any case.
   */
  if (/coming[- ]soon|pre[- ]?order/i.test(`${title} ${url}`)) return false;
  if (isNonVehicle(title)) return false;
  // A truck does not cost less than a used set of tyres.
  if (price !== null && price < 1500) return false;
  const filedAsVehicle = /^(vehicles?|trucks?|vans?|cars?|mini ?trucks?|kei ?trucks?)$/i.test(type.trim());
  return filedAsVehicle || /\b(19[5-9]\d|20[0-3]\d)\b/.test(title);
}

/** Whether a listing answers the caller's make, model and keywords. */
export function matchesQuery(q: SearchQuery, make: string | null, model: string | null, title: string): boolean {
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (q.make && !(make && norm(make) === norm(q.make)) && !title.toLowerCase().includes(q.make.toLowerCase())) return false;
  if (q.models?.length) {
    const hay = norm(`${model ?? ''} ${title}`);
    if (!q.models.some((m) => hay.includes(norm(m)))) return false;
  }
  if (!q.make && q.keywords) {
    const terms = q.keywords.split('|').map((t) => t.replace(/"/g, '').trim().toLowerCase()).filter(Boolean);
    if (terms.length && !terms.some((t) => title.toLowerCase().includes(t))) return false;
  }
  return true;
}

/** "S211P-0021618" is a Japanese chassis number, not a 17-character VIN. */
function chassisNumber(value: string | undefined): string | undefined {
  return value && /^[A-Z0-9]{2,6}-\d{5,8}$/i.test(value.trim()) ? value.trim().toUpperCase() : undefined;
}

const strip = (html: string | undefined) => (html ?? '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

interface ShopifyProduct {
  id?: number;
  title?: string;
  handle?: string;
  body_html?: string;
  product_type?: string;
  vendor?: string;
  tags?: string[];
  published_at?: string;
  variants?: { price?: string; available?: boolean; sku?: string }[];
  images?: { src?: string }[];
}

/**
 * A Shopify shop, read from the catalogue every Shopify store publishes.
 *
 * Tags carry the facts a product page shows as badges ("4WD", "5-Speed Manual",
 * "Street Legal"), and a "Location_" tag, where present, overrides the shop's
 * own location: one Japan-based exporter lists a truck that is sitting in
 * Australia, and a buyer in California needs to know that before anything else.
 */
export function shopifyStore(spec: StorefrontSpec): SourceAdapter {
  return {
    source: getSource(spec.id)!,

    async search(query, ctx): Promise<Listing[]> {
      const now = new Date().toISOString();
      const out = new Map<string, ListingDraft>();
      let parts = 0;
      let soldOut = 0;

      for (let page = 1; page <= 10; page += 1) {
        let products: ShopifyProduct[] = [];
        try {
          const res = await fetchWithTls(`${spec.host}/products.json?limit=250&page=${page}`);
          if (res.status !== 200) {
            ctx.log(`${spec.id} p${page} HTTP ${res.status}`);
            break;
          }
          products = (JSON.parse(res.body ?? '{}') as { products?: ShopifyProduct[] }).products ?? [];
        } catch (e) {
          ctx.log(`${spec.id} p${page} FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }
        if (products.length === 0) break;

        for (const p of products) {
          const title = (p.title ?? '').replace(/\s+/g, ' ').trim();
          const variant = p.variants?.[0];
          const price = variant?.price ? Number(variant.price) : null;
          if (!p.id || !title || price === null || !Number.isFinite(price)) continue;
          if (!isVehicleProduct(title, p.product_type ?? '', price, p.handle ?? '')) { parts += 1; continue; }
          // A sold truck stays in the catalogue marked unavailable.
          if (variant?.available === false) { soldOut += 1; continue; }

          const tags = p.tags ?? [];
          const body = strip(p.body_html);
          const make = parseMake(title);
          const model = parseModel(title, make);
          if (!matchesQuery(query, make, model, title)) continue;

          const locationTag = tags.find((t) => /^location_/i.test(t))?.replace(/^location_/i, '');
          const miles = mileageFrom(`${title} ${body}`);
          const id = `${spec.id}:${p.id}`;
          out.set(id, {
            id,
            sourceId: spec.id,
            sourceListingId: String(p.id),
            url: p.handle ? `${spec.host}/products/${p.handle}` : spec.host,
            title,
            year: parseYear(title),
            make,
            model,
            trim: null,
            series: null,
            vin: null,
            price,
            priceKind: 'ask',
            currency: spec.currency ?? 'USD',
            mileage: miles,
            mileageIsRounded: isRoundedMileage(miles),
            location: locationTag ?? spec.location,
            sellerType: 'dealer',
            dealerName: p.vendor ?? null,
            transmission: parseTransmission(tags.find((t) => /speed|manual|automatic|cvt/i.test(t)) ?? body),
            drivetrain: parseDrivetrain(tags.find((t) => /^(2wd|4wd|awd|4x4)$/i.test(t)) ?? title),
            eventDate: null,
            imageUrl: p.images?.[0]?.src ?? null,
            firstSeen: now,
            lastSeen: now,
            raw: {
              tags,
              streetLegal: tags.some((t) => /street legal/i.test(t)) || undefined,
              publishedAt: p.published_at,
              stockNumber: variant?.sku || undefined,
            },
          });
        }
        if (products.length < 250) break;
      }

      ctx.log(`${spec.id}: ${out.size} vehicles${parts ? `, ${parts} parts and deposits skipped` : ''}${soldOut ? `, ${soldOut} sold out` : ''}`);
      return [...out.values()].map(makeListing);
    },
  };
}

interface WooProduct {
  id?: number;
  name?: string;
  permalink?: string;
  short_description?: string;
  description?: string;
  is_in_stock?: boolean;
  prices?: { price?: string; currency_code?: string; currency_minor_unit?: number };
  categories?: { name?: string }[];
  attributes?: { name?: string; terms?: { name?: string }[] }[];
  images?: { src?: string }[];
}

const decode = (v: string) => v.replace(/&amp;/g, '&').replace(/&#8243;/g, '"').replace(/&#8217;/g, "'").replace(/&[a-z#0-9]+;/gi, ' ');

/**
 * A WooCommerce shop, read from the public Store API.
 *
 * Prices arrive in minor units with the unit count alongside ("599900" and 2),
 * so a naive read turns a $5,999 truck into a $599,900 one. Attributes, where
 * the importer fills them in, are the most reliable facts in the listing: one
 * shop states the year, the make, the transmission and the Japanese chassis
 * number for every truck, and those beat anything parsed out of a product name.
 */
export function wooStore(spec: StorefrontSpec): SourceAdapter {
  return {
    source: getSource(spec.id)!,

    async search(query, ctx): Promise<Listing[]> {
      const now = new Date().toISOString();
      const out = new Map<string, ListingDraft>();
      let parts = 0;

      for (let page = 1; page <= 10; page += 1) {
        let products: WooProduct[] = [];
        try {
          const res = await fetchWithTls(`${spec.host}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
          if (res.status !== 200) {
            if (page === 1) ctx.log(`${spec.id} HTTP ${res.status}`);
            break;
          }
          const parsed = JSON.parse(res.body ?? '[]') as unknown;
          products = Array.isArray(parsed) ? (parsed as WooProduct[]) : [];
        } catch (e) {
          ctx.log(`${spec.id} p${page} FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }
        if (products.length === 0) break;

        for (const p of products) {
          const title = decode(p.name ?? '').replace(/\s+/g, ' ').trim();
          const minor = p.prices?.currency_minor_unit ?? 2;
          const rawPrice = p.prices?.price ? Number(p.prices.price) : NaN;
          const price = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice / 10 ** minor : null;
          if (!p.id || !title || price === null) continue;
          if (p.is_in_stock === false) continue;

          const attr = (name: RegExp): string | undefined =>
            p.attributes?.find((a) => name.test(a.name ?? ''))?.terms?.map((t) => decode(t.name ?? '')).join(' ') || undefined;
          const categories = (p.categories ?? []).map((c) => decode(c.name ?? ''));
          const vehicleCategory = categories.some((c) => /truck|van|vehicle|inventory|cars?\b/i.test(c) && !/part|accessor/i.test(c));
          const statedYear = Number(attr(/^year$/i));
          const type = vehicleCategory || attr(/^make$/i) ? 'Vehicle' : '';
          if (!isVehicleProduct(title, type, price, p.permalink ?? '')) { parts += 1; continue; }

          const make = attr(/^make$/i) ?? parseMake(title);
          const model = attr(/^model$/i) ?? parseModel(title, make);
          if (!matchesQuery(query, make, model, `${title} ${model ?? ''}`)) continue;

          const text = `${title} ${strip(p.short_description)} ${strip(p.description)}`;
          const miles = mileageFrom(`${attr(/mileage|odometer|kilomet/i) ?? ''} ${text}`);
          const id = `${spec.id}:${p.id}`;
          out.set(id, {
            id,
            sourceId: spec.id,
            sourceListingId: String(p.id),
            url: p.permalink ?? spec.host,
            title,
            year: statedYear > 1900 ? statedYear : parseYear(title),
            make,
            model,
            trim: null,
            series: null,
            vin: null,
            price,
            priceKind: 'ask',
            currency: (p.prices?.currency_code ?? spec.currency ?? 'USD').toUpperCase(),
            mileage: miles,
            mileageIsRounded: isRoundedMileage(miles),
            /**
             * "Import-to-Order" is a truck still in Japan that the shop will
             * buy on the buyer's behalf. It is a real offer at a real price and
             * is kept, but saying where it is matters more than anything else
             * about it: it is months and a customs clearance away.
             */
            location: /import[- ]to[- ]order/i.test(title) ? 'Japan (import to order)' : spec.location,
            sellerType: 'dealer',
            transmission: parseTransmission(attr(/transmission/i) ?? text),
            drivetrain: parseDrivetrain(attr(/drive/i) ?? text),
            bodyType: canonicalBodyType(attr(/body/i)),
            exteriorColor: canonicalColor(attr(/colou?r/i)),
            eventDate: null,
            imageUrl: p.images?.[0]?.src ?? null,
            firstSeen: now,
            lastSeen: now,
            raw: {
              categories,
              chassisNumber: chassisNumber(attr(/^vin$|chassis/i)),
              stockNumber: attr(/stock/i),
              importToOrder: /import[- ]to[- ]order/i.test(title) || undefined,
            },
          });
        }
        if (products.length < 100) break;
      }

      ctx.log(`${spec.id}: ${out.size} vehicles${parts ? `, ${parts} parts skipped` : ''}`);
      return [...out.values()].map(makeListing);
    },
  };
}

/**
 * The specialist kei sellers whose catalogues are open.
 *
 * Found by asking which shop software each importer runs rather than by writing
 * a scraper per site: seven of fifteen specialists turned out to publish their
 * catalogue at a platform's fixed path. The rest sit behind closed WooCommerce
 * APIs, bespoke dealer software or Wix, and are recorded as not yet readable.
 */
export const keitrucksamerica = shopifyStore({ id: 'keitrucksamerica', host: 'https://www.kei-trucks.com', location: 'West Lafayette, IN' });
export const minitrucksnet = shopifyStore({ id: 'minitrucksnet', host: 'https://minitrucks.net', location: 'Japan (exporter)' });
export const jpmminitrucks = wooStore({ id: 'jpmminitrucks', host: 'https://jpmminitrucks.com', location: 'Miami, FL' });
export const minitruckimports = wooStore({ id: 'minitruckimports', host: 'https://minitruckimports.com', location: 'Louisiana' });
export const keitrucksmarket = wooStore({ id: 'keitrucksmarket', host: 'https://keitrucksmarket.com', location: 'Federal Way, WA' });
export const keitruckimporters = wooStore({ id: 'keitruckimporters', host: 'https://keitruckimporters.com', location: 'location not published' });
