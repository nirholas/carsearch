import type { SourceAdapter, SearchQuery } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { isRoundedMileage, isValidVin, canonicalMake, canonicalModel } from '../core/normalize.js';
import { canonicalBodyType, canonicalFuelType, canonicalColor } from '../core/canonical.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';

/**
 * Dealer.com (DDC) storefronts, read through the widget API their own pages call.
 *
 * This is a factory rather than an adapter because dealer.com is a platform, not
 * a site. Every storefront on it answers the same POST at the same path with the
 * same payload shape, so a new one costs three lines: an id, a host and a
 * siteId. The two wired here are rental defleet, which is inventory that appears
 * in no aggregator this index already reads and is unusually honest stock: one
 * owner, a known service history, and a title that was never in private hands.
 *
 * Hertz alone reports 6,450 cars.
 *
 * DO NOT scrape the rendered listing pages. They are 764KB of markup carrying
 * about two dozen cars, while one API call returns 48 fully typed records with
 * VIN, trim, odometer, drivetrain and colour already separated.
 *
 * THE PAGINATION KEY IS INSIDE `inventoryParameters`, and every obvious
 * alternative silently fails. Measured against Hertz by comparing VINs with the
 * first page:
 *
 *   inventoryParameters.start   0 of 48 shared    <- the real one
 *   top-level start            48 of 48 shared
 *   preferences.start          48 of 48 shared
 *   preferences.offset         48 of 48 shared
 *   pageNum                    48 of 48 shared
 *
 * All five answer 200 with a full page and the correct `totalCount`, so four of
 * them look exactly like success and would have capped this source at 48 cars.
 * Any future change here must be checked the same way, on returned ids rather
 * than on counts.
 */

export interface DealerSpec {
  /** Registry id. */
  id: string;
  /** Origin, no trailing slash. */
  host: string;
  /**
   * DDC's own name for the storefront, which is often NOT the domain.
   *
   * Optional because it is discovered from the site's own inventory page when
   * omitted, which is the only way to get it right: see `discoverConfig`.
   */
  siteId?: string;
  /** Which inventory config to read. Discovered when omitted. */
  listingConfigId?: string;
  /** Where the cars physically are, when the records do not say. */
  fallbackLocation?: string;
}

/** The server caps a page at 48 however large a `pageSize` is requested. */
const PAGE_SIZE = 48;

/**
 * A ceiling, not an expectation: the loop stops on the first page that adds no
 * car it does not already hold, and on any short page.
 */
const MAX_PAGES = 60;

/**
 * The rooftops behind a group's stock, returned beside the cars.
 *
 * A group storefront serves every store it owns, and the vehicle records carry
 * no address of their own: `locationDistance` is present on a single-rooftop
 * site like Hertz and absent on every group site, so the first fifteen dealer
 * groups wired here stored 473 Macans with a null location. A buyer choosing
 * between a car in Honolulu and one an hour away cannot use a listing that
 * declines to say which it is.
 *
 * Each response carries an `accounts` map keyed by exactly the `accountId` on
 * the vehicle, so the join is direct and total: 15 of 15 resolved on the first
 * Lithia page.
 */
interface DdcAccount {
  name?: string;
  address?: { city?: string; state?: string; accountName?: string };
}

export function placeFromAccount(a: DdcAccount | undefined): string | null {
  const city = a?.address?.city?.trim();
  const state = a?.address?.state?.trim();
  const where = [city, state].filter(Boolean).join(', ');
  const who = (a?.name ?? a?.address?.accountName)?.trim();
  if (where && who) return `${who} (${where})`;
  return where || who || null;
}

interface DdcAttribute { name?: string; value?: string; normalizedValue?: string }

export interface DdcVehicle {
  year?: number;
  make?: string;
  model?: string;
  trim?: string;
  vin?: string;
  uuid?: string;
  stockNumber?: string;
  accountId?: string;
  link?: string;
  title?: string | { label?: string; value?: string }[];
  bodyStyle?: string;
  fuelType?: string;
  condition?: string;
  certified?: boolean;
  images?: { uri?: string; alt?: string }[];
  pricing?: { retailPrice?: string; dprice?: { label?: string; value?: string; typeClass?: string }[] };
  attributes?: DdcAttribute[];
  highlightedAttributes?: DdcAttribute[];
  trackingAttributes?: DdcAttribute[];
}

const attr = (v: DdcVehicle, name: string): string | null => {
  for (const list of [v.highlightedAttributes, v.trackingAttributes, v.attributes]) {
    const hit = list?.find((a) => a.name === name);
    if (hit?.value) return hit.value;
  }
  return null;
};

/** "$42,934" and "8,510 miles" both reduce to their number, or to null. */
export function numberIn(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The advertised price.
 *
 * `retailPrice` is the sticker. `dprice` carries the dealer's own labelled
 * ladder, and the entry marked `askingPrice` is what the car is actually
 * offered at, which on a defleet site is usually a few hundred above retail
 * rather than below it. The asking price wins where it exists because that is
 * the number a buyer would be quoted; retail is the fallback.
 */
export function priceOf(p: DdcVehicle['pricing']): number | null {
  const asking = p?.dprice?.find((d) => d.typeClass === 'askingPrice');
  return numberIn(asking?.value) ?? numberIn(p?.retailPrice);
}

/** Records state "Pittsburgh, PA :::" with the distance stripped out. */
export function placeOf(v: DdcVehicle): string | null {
  const raw = attr(v, 'locationDistance');
  if (!raw) return null;
  const place = raw.split(':::')[0]?.trim();
  return place ? place : null;
}

function titleOf(v: DdcVehicle): string {
  if (typeof v.title === 'string') return v.title;
  if (Array.isArray(v.title)) {
    const joined = v.title.map((t) => t.value ?? t.label).filter(Boolean).join(' ').trim();
    if (joined) return joined;
  }
  return [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');
}

/**
 * The `siteId` and `listing.config.id` a storefront actually uses, read off its
 * own inventory page.
 *
 * Guessing these is the trap this function exists to close, and the failure is
 * not an error. Lithia answers to `siteId: "lithia"` with 40,995 cars and NO
 * `pricing`, `trackingPricing` or `link` field on any of them: a complete,
 * plausible, unusable response. Its real id is `lithiagroupsite` with
 * `auto-used-50onlot`, and under those every record carries an asking price. A
 * wrong id here does not 404, it quietly drops the columns that matter.
 *
 * Cached per host for the process, because it is one request that answers for
 * every page of every model afterwards.
 */
/**
 * Which `listing.config.id` on the page describes USED inventory.
 *
 * Taking the first value found is wrong and quietly so, because a group page
 * declares every config it serves, comma-joined, new cars included. Measured:
 * Hendrick's first value is `auto-exotic-used` and returns 20 cars where
 * `auto-used` returns 11,719; Sonic's first is `auto-new`, which answers with a
 * healthy 24,074 that are the wrong cars entirely; Ourisman's is
 * `auto-used on-platform`, a subset of its 3,327. Each one looks like a working
 * source, which is why this picks deliberately rather than taking what comes
 * first.
 */
export function pickUsedConfig(html: string): string {
  const values = [...html.matchAll(/"listing\.config\.id"\s*:\s*"([^"]+)"/g)]
    .flatMap((m) => m[1]!.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  return values.find((v) => v === 'auto-used')
    ?? values.find((v) => /used/.test(v) && !/exotic|certified|shared/.test(v))
    ?? values.find((v) => /used/.test(v))
    ?? 'auto-used';
}

const CONFIG_CACHE = new Map<string, { siteId: string; listingConfigId: string } | null>();

export async function discoverConfig(
  host: string,
  log: (m: string) => void,
): Promise<{ siteId: string; listingConfigId: string } | null> {
  const cached = CONFIG_CACHE.get(host);
  if (cached !== undefined) return cached;

  let found: { siteId: string; listingConfigId: string } | null = null;
  try {
    const res = await fetchWithTls(`${host}/used-inventory/index.htm`, { headers: { accept: 'text/html' } }, { browser: 'chrome' });
    if (res.status === 200) {
      const siteId = res.body.match(/"siteId"\s*:\s*"([^"]+)"/)?.[1];
      if (siteId) found = { siteId, listingConfigId: pickUsedConfig(res.body) };
    }
  } catch {
    // Discovery is best-effort; the spec's own values are the fallback.
  }
  if (found) log(`${host}: siteId="${found.siteId}" listing.config.id="${found.listingConfigId}"`);
  CONFIG_CACHE.set(host, found);
  return found;
}

export function dealerDotCom(spec: DealerSpec): SourceAdapter {
  return {
    source: getSource(spec.id)!,

    async search(query: SearchQuery, ctx) {
      const now = new Date().toISOString();
      const out = new Map<string, ListingDraft>();
      const models = query.models?.length ? query.models : [undefined];

      /** accountId -> rooftop, accumulated across pages. */
      const accounts = new Map<string, DdcAccount>();

      const discovered = await discoverConfig(spec.host, ctx.log);
      const siteId = spec.siteId ?? discovered?.siteId;
      const listingConfigId = spec.listingConfigId ?? discovered?.listingConfigId ?? 'auto-used';
      if (!siteId) {
        ctx.log(`${spec.id}: could not read a siteId from ${spec.host}, skipping`);
        return [];
      }

      for (const model of models) {
        let total: number | null = null;

        for (let page = 0; page < MAX_PAGES; page += 1) {
          /**
           * THE FILTER IS CASE-SENSITIVE and a wrong case is not an error.
           *
           * Measured against Lithia: `Porsche` returns 611 cars, `porsche` and
           * `PORSCHE` each return 200 with a total of 0, which is
           * indistinguishable from a group that stocks no Porsches. The CLI
           * hands makes through in whatever case the user typed, so this was
           * worth exactly one silent empty source. `BMW` and `Mercedes-Benz`
           * rule out naive title-casing as the fix, since it would produce
           * `Bmw` and `Mercedes-benz` and both return nothing.
           */
          const inventoryParameters: Record<string, string[]> = { start: [String(page * PAGE_SIZE)] };
          const make = canonicalMake(query.make ?? null);
          const wantModel = canonicalModel(model ?? null);
          if (make) inventoryParameters.make = [make];
          if (wantModel) inventoryParameters.model = [wantModel];

          const body = JSON.stringify({
            siteId,
            locale: 'en_US',
            device: 'DESKTOP',
            pageAlias: 'INVENTORY_LISTING_DEFAULT_AUTO_USED',
            pageId: 'v9_INVENTORY_SEARCH_RESULTS_AUTO_USED_V1_1',
            windowId: 'inventory-data-bus1',
            widgetName: 'ws-inv-data',
            inventoryParameters,
            includePricing: true,
            flags: { 'ws-scripts-inventory-data': true },
            preferences: { pageSize: String(PAGE_SIZE), 'listing.config.id': listingConfigId },
          });

          let cars: DdcVehicle[];
          try {
            const res = await fetchWithTls(`${spec.host}/api/widget/ws-inv-data/getInventory`, {
              method: 'POST',
              body,
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            }, { browser: 'chrome' });
            if (res.status !== 200 || !res.body) {
              ctx.log(`${spec.id} ${model ?? 'all'} p${page}: HTTP ${res.status}`);
              break;
            }
            const parsed = JSON.parse(res.body) as {
              inventory?: DdcVehicle[];
              pageInfo?: { totalCount?: number };
              accounts?: Record<string, DdcAccount>;
            };
            cars = parsed.inventory ?? [];
            for (const [k, v] of Object.entries(parsed.accounts ?? {})) accounts.set(k, v);
            if (total === null) total = parsed.pageInfo?.totalCount ?? null;
          } catch (e) {
            ctx.log(`${spec.id} ${model ?? 'all'} p${page} FAILED: ${(e as Error).message.split('\n')[0]}`);
            break;
          }

          if (cars.length === 0) break;
          const before = out.size;

          for (const v of cars) {
            const key = v.vin ?? v.uuid ?? v.stockNumber;
            if (!key) continue;
            const id = `${spec.id}:${key}`;
            if (out.has(id)) continue;

            const price = priceOf(v.pricing);
            if (price === null) continue;
            const mileage = numberIn(attr(v, 'odometer'));
            const place = placeOf(v)
              ?? placeFromAccount(v.accountId ? accounts.get(String(v.accountId)) : undefined)
              ?? spec.fallbackLocation
              ?? null;

            out.set(id, {
              id,
              sourceId: spec.id,
              sourceListingId: v.stockNumber ?? v.uuid ?? null,
              url: v.link ? `${spec.host}${v.link.startsWith('/') ? '' : '/'}${v.link}` : spec.host,
              title: titleOf(v),
              year: Number.isFinite(v.year) ? Number(v.year) : null,
              make: v.make ?? query.make ?? null,
              model: v.model ?? model ?? null,
              trim: v.trim || null,
              vin: isValidVin(v.vin) ? v.vin!.toUpperCase() : null,
              price,
              priceKind: 'ask',
              currency: 'USD',
              mileage,
              mileageIsRounded: isRoundedMileage(mileage),
              location: place,
              sellerType: 'dealer',
              certified: v.certified ?? null,
              bodyType: canonicalBodyType(v.bodyStyle),
              fuelType: canonicalFuelType(attr(v, 'normalFuelType') ?? v.fuelType),
              exteriorColor: canonicalColor(attr(v, 'exteriorColor')),
              transmission: parseTransmission(attr(v, 'transmission')),
              drivetrain: parseDrivetrain(attr(v, 'driveLine')),
              mpgCity: numberIn(attr(v, 'cityFuelEconomy')),
              mpgHighway: numberIn(attr(v, 'highwayFuelEconomy')),
              engine: attr(v, 'engine'),
              /**
               * Every car on a defleet site came off the rental line, which is
               * real history a buyer should price in rather than a title brand.
               */
              usage: 'rental',
              imageUrl: v.images?.[0]?.uri ?? null,
              firstSeen: now,
              lastSeen: now,
            });
          }

          ctx.log(
            `${spec.id} ${(model ?? 'all').padEnd(12)} p${page} ${String(cars.length).padStart(3)} cars ` +
            `(pool ${out.size} of ${total ?? '?'})`,
          );

          if (out.size === before) break;
          if (cars.length < PAGE_SIZE) break;
          if (total !== null && (page + 1) * PAGE_SIZE >= total) break;
        }

        // Zero for a filtered query is the shape a wrong filter value takes
        // here, so it is reported rather than returned as an empty answer.
        if (total === 0 && (query.make || model)) {
          ctx.log(
            `${spec.id}: 0 cars for make="${canonicalMake(query.make ?? null) ?? '-'}" ` +
            `model="${canonicalModel(model ?? null) ?? '-'}". Either the group stocks none, ` +
            `or the value is not spelled the way this site spells it.`,
          );
        }
      }

      return [...out.values()].map(makeListing);
    },
  };
}

/** Rental defleet, one owner and a full service history by construction. */
export const hertzcarsales = dealerDotCom({
  id: 'hertzcarsales',
  host: 'https://www.hertzcarsales.com',
  siteId: 'hertzcarsales',
});

/**
 * One of the largest dealer groups in the US, and the biggest single catalogue
 * this index reaches: 40,995 used cars across every franchise it holds, so the
 * stock is not concentrated in one brand the way a single-marque store is.
 */
export const lithia = dealerDotCom({
  id: 'lithia',
  host: 'https://www.lithia.com',
});

/**
 * Dealer groups found by scanning the largest US operators for the DDC widget.
 *
 * Each is one storefront serving a whole group's stock rather than a single
 * rooftop, which is why the counts are in the thousands. None carries a siteId:
 * `discoverConfig` reads it, because on four of these seven the id is not the
 * domain (Suburban answers to `lithiacollection`, Hendrick to
 * `hendrickautogroup`, AutoFair to `amsiautofair`, Fred Beans to
 * `fredbeansdoylestown3`).
 */
export const hendrick = dealerDotCom({ id: 'hendrick', host: 'https://www.hendrickcars.com' });
export const sonicautomotive = dealerDotCom({ id: 'sonicautomotive', host: 'https://www.sonicautomotive.com' });
export const suburbancollection = dealerDotCom({ id: 'suburbancollection', host: 'https://www.suburbancollection.com' });
export const ourisman = dealerDotCom({ id: 'ourisman', host: 'https://www.ourisman.com' });
export const fredbeans = dealerDotCom({ id: 'fredbeans', host: 'https://www.fredbeans.com' });
export const tomwood = dealerDotCom({ id: 'tomwood', host: 'https://www.tomwood.com' });
export const autofair = dealerDotCom({ id: 'autofair', host: 'https://www.autofair.com' });

/** A second scan of large US groups, same platform, same three lines each. */
export const herbchambers = dealerDotCom({ id: 'herbchambers', host: 'https://www.herbchambers.com' });
export const jimellis = dealerDotCom({ id: 'jimellis', host: 'https://www.jimellis.com' });
export const leithcars = dealerDotCom({ id: 'leithcars', host: 'https://www.leithcars.com' });
export const garberauto = dealerDotCom({ id: 'garberauto', host: 'https://www.garberauto.com' });
export const huffines = dealerDotCom({ id: 'huffines', host: 'https://www.huffines.net' });
export const fermanauto = dealerDotCom({ id: 'fermanauto', host: 'https://www.fermanauto.com' });
export const jakesweeney = dealerDotCom({ id: 'jakesweeney', host: 'https://www.jakesweeney.com' });
export const hallauto = dealerDotCom({ id: 'hallauto', host: 'https://www.hallauto.com' });
