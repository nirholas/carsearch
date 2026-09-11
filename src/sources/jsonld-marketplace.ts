import { createHash } from 'node:crypto';
import type { SourceAdapter, SearchQuery, Listing } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { extractJsonLd, vehicleNodes, scalar, num, offerPrice, offerLocation, firstImage, type JsonLdNode } from './jsonld.js';
import { parseYear, parseMake, parseModel, isRoundedMileage } from '../core/normalize.js';
import { canonicalFuelType, canonicalBodyType, canonicalColor } from '../core/canonical.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';

/**
 * One adapter for every marketplace that publishes schema.org Car or Product
 * entries.
 *
 * Sites that ship this markup ship it in the same shape, because they all
 * generate it for the same search engines. Writing a bespoke adapter per site
 * would be the same forty lines repeated with different URLs, and each copy
 * would need the same unit and currency traps fixed independently.
 *
 * Three sources came from a single fix to the JSON-LD reader: AutoScout24,
 * Finn.no and Blocket were all invisible because their ItemList sits under
 * `mainEntity` rather than at the top level.
 */

export interface MarketplaceSpec {
  /** Registry id. Must already exist in the registry. */
  id: string;
  /** Builds a search URL for a make and an optional model. */
  url: (query: SearchQuery, model?: string) => string;
  /** Absolute origin, for turning the relative offer links these sites use into real URLs. */
  origin: string;
  /** Currency when the payload omits one. Never converted, only recorded. */
  currency: string;
  /**
   * Whether the site's own search actually narrows by make.
   *
   * Several do not, and a page of unrelated cars is only harmful if it is
   * labelled with what was asked for. Every row keeps its own brand either way;
   * this only controls whether the mismatch is reported.
   */
  filtersByMake?: boolean;
  /**
   * Whether the site's search URL actually narrows to the requested model.
   *
   * Several address a make only. Returning that make's whole catalogue for a
   * model query is not thin inventory, it is the wrong answer: a search for a
   * BMW i8 came back with X3s, X5s and 3 Series, each of them real and none of
   * them the car. When this is false the rows are filtered on the model they
   * state for themselves.
   */
  filtersByModel?: boolean;
  /**
   * Normalizes a listing name before anything is parsed out of it.
   *
   * A site with a known title shape can say so once here rather than having
   * every downstream parser learn its phrasing. PakWheels appends "for sale in
   * <city>" after the year, which left the model parser reading the remainder
   * after the year and storing "For" as the model of every listing.
   */
  cleanTitle?: (name: string) => string;
}

/**
 * Odometer readings arrive in whichever unit the country uses, tagged with a
 * UN/CEFACT code. Storing a kilometre figure as miles ranks a 20,900 km car
 * ahead of a 30,000 mile one that is genuinely newer, and nothing downstream
 * could detect it.
 */
function odometerMiles(node: JsonLdNode): { miles: number | null; converted: boolean } {
  const raw = node.mileageFromOdometer;
  if (!raw) return { miles: null, converted: false };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const n = num(raw);
    return { miles: n, converted: false };
  }
  const q = raw as JsonLdNode;
  const value = num(q.value);
  if (value === null) return { miles: null, converted: false };
  const unit = String(q.unitCode ?? q.unitText ?? '').toUpperCase();
  // KMT is the UN/CEFACT code for kilometres; SMI is the statute mile.
  const isKm = unit === 'KMT' || /\bkm\b|kilomet/i.test(unit);
  return { miles: isKm ? Math.round(value * 0.621371) : value, converted: isKm };
}

/** These sites publish relative offer links; a relative URL is not a link. */
function absolute(origin: string, href: string | null): string | null {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return origin.replace(/\/$/, '') + (href.startsWith('/') ? href : `/${href}`);
}

function offerUrl(node: JsonLdNode): string | null {
  const offers = node.offers ?? node.offer;
  const first = (Array.isArray(offers) ? offers[0] : offers) as JsonLdNode | undefined;
  return scalar(first?.url) ?? scalar(node.url) ?? scalar(node['@id']);
}

/**
 * A stable short id for a listing key.
 *
 * This was base64 of the key truncated to 44 characters, which encodes only the
 * first 33 bytes of it. Every listing on a site shares a long URL prefix, so the
 * truncation landed inside the part they have in common: Car & Classic returned
 * 57 priced cars and they collapsed into 2 ids, and the adapter reported "59
 * items, 2 kept" as though the site had published almost nothing. A hash reads
 * the whole key, so two URLs that differ anywhere differ here.
 */
function fingerprint(key: string): string {
  return createHash('sha1').update(key).digest('base64url').slice(0, 22);
}

/**
 * Whether a listing is the model that was asked for.
 *
 * The record's own model field is the arbiter where it has one; the name is
 * consulted only when it does not, because a site that states no model must not
 * be assumed to be selling the one requested. Compared on alphanumerics, so
 * "718 Cayman" matches "Cayman" and "i3" never matches "i8".
 */
function sameModel(stated: string | null, name: string, wanted: string): boolean {
  if (!wanted.trim()) return true;
  if (stated) return tokensMatch(stated, wanted);
  return new RegExp(`\\b${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(name);
}

/**
 * Whether two model names describe the same model.
 *
 * Compared as token sets rather than by prefix, because a prefix test gets
 * "718 Cayman" against "Cayman" wrong: the generation number leads, so neither
 * string starts with the other. Every token of the shorter name must appear in
 * the longer one, which matches a trim to its model ("i8 Coupe" to "i8") while
 * still keeping "i3" and "i8" apart.
 */
function tokensMatch(a: string, b: string): boolean {
  const tokens = (v: string) => new Set(v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return false;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

export function jsonLdMarketplace(spec: MarketplaceSpec): SourceAdapter {
  return {
    source: getSource(spec.id)!,

    async search(query, ctx) {
      const out = new Map<string, ListingDraft>();
      const models = query.models?.length ? query.models : [undefined];
      let offTopic = 0;
      let offModel = 0;
      let kmConverted = 0;

      for (const model of models) {
        const url = spec.url(query, model);
        try {
          const res = await fetchWithTls(url);
          if (res.status !== 200) {
            ctx.log(`${spec.id} ${model ?? 'all'} HTTP ${res.status}`);
            continue;
          }

          const items = vehicleNodes(extractJsonLd(res.body));
          let kept = 0;

          for (const item of items) {
            const raw = scalar(item.name);
            const name = raw && spec.cleanTitle ? spec.cleanTitle(raw) : raw;
            const price = offerPrice(item);
            if (!name || price === null) continue;

            const href = offerUrl(item);
            // These payloads carry no listing id, so the offer path is the key.
            const key = href ?? `${name}:${price}`;
            const id = `${spec.id}:${fingerprint(key)}`;
            if (out.has(id)) continue;

            const brand = scalar((item.brand as JsonLdNode | undefined)?.name) ?? scalar(item.brand);
            const make = brand ?? parseMake(name);
            if (query.make && make && !make.toLowerCase().includes(query.make.toLowerCase())) {
              offTopic += 1;
              if (!spec.filtersByMake) continue;
            }

            const stated = scalar(item.model) ?? parseModel(name, make);
            if (model && spec.filtersByModel === false && !sameModel(stated, name, model)) {
              offModel += 1;
              continue;
            }

            const { miles, converted } = odometerMiles(item);
            if (converted) kmConverted += 1;

            const offers = (Array.isArray(item.offers) ? item.offers[0] : item.offers) as JsonLdNode | undefined;

            out.set(id, {
              id,
              sourceId: spec.id,
              sourceListingId: null,
              url: absolute(spec.origin, href),
              title: name,
              /**
               * Year is genuinely absent from these payloads. Reading it out of
               * the name recovers it where the seller wrote one and leaves it
               * null otherwise, which is the honest answer.
               */
              year: parseYear(name) ?? num(item.vehicleModelDate) ?? num(item.productionDate),
              make,
              model: stated,
              trim: scalar(item.vehicleConfiguration),
              price,
              priceKind: 'ask',
              currency: (scalar(offers?.priceCurrency) ?? spec.currency).toUpperCase(),
              mileage: miles,
              mileageIsRounded: isRoundedMileage(miles),
              location: offerLocation(item),
              sellerType: 'dealer',
              bodyType: canonicalBodyType(item.bodyType),
              fuelType: canonicalFuelType(item.fuelType),
              exteriorColor: canonicalColor(item.color),
              transmission: parseTransmission(scalar(item.vehicleTransmission)),
              drivetrain: parseDrivetrain(scalar(item.driveWheelConfiguration)),
              imageUrl: firstImage(item),
              raw: { description: scalar(item.description) ?? undefined },
            });
            kept += 1;
          }
          ctx.log(`${spec.id} ${(model ?? 'all').padEnd(14)} ${String(items.length).padStart(3)} items, ${kept} kept (pool ${out.size})`);
        } catch (e) {
          ctx.log(`${spec.id} ${model ?? 'all'} FAILED: ${(e as Error).message.split('\n')[0]}`);
        }
      }

      if (offTopic) {
        ctx.log(
          `${spec.id}: ${offTopic} rows are not ${query.make}` +
          `${spec.filtersByMake ? ' despite their filter' : ' (their search does not filter by make)'}`,
        );
      }
      if (offModel) {
        ctx.log(`${spec.id}: ${offModel} rows are not the requested model (their search narrows by make only)`);
      }
      if (kmConverted) ctx.log(`${spec.id}: converted ${kmConverted} kilometre readings to miles`);

      return [...out.values()].map(makeListing) as Listing[];
    },
  };
}
