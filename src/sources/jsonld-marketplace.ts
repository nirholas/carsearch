import type { SourceAdapter, SearchQuery, Listing } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { extractJsonLd, itemListEntries, scalar, num, offerPrice, offerLocation, firstImage, type JsonLdNode } from './jsonld.js';
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

export function jsonLdMarketplace(spec: MarketplaceSpec): SourceAdapter {
  return {
    source: getSource(spec.id)!,

    async search(query, ctx) {
      const out = new Map<string, ListingDraft>();
      const models = query.models?.length ? query.models : [undefined];
      let offTopic = 0;
      let kmConverted = 0;

      for (const model of models) {
        const url = spec.url(query, model);
        try {
          const res = await fetchWithTls(url);
          if (res.status !== 200) {
            ctx.log(`${spec.id} ${model ?? 'all'} HTTP ${res.status}`);
            continue;
          }

          const items = itemListEntries(extractJsonLd(res.body));
          let kept = 0;

          for (const item of items) {
            const name = scalar(item.name);
            const price = offerPrice(item);
            if (!name || price === null) continue;

            const href = offerUrl(item);
            // These payloads carry no listing id, so the offer path is the key.
            const key = href ?? `${name}:${price}`;
            const id = `${spec.id}:${Buffer.from(key).toString('base64url').slice(0, 44)}`;
            if (out.has(id)) continue;

            const brand = scalar((item.brand as JsonLdNode | undefined)?.name) ?? scalar(item.brand);
            const make = brand ?? parseMake(name);
            if (query.make && make && !make.toLowerCase().includes(query.make.toLowerCase())) {
              offTopic += 1;
              if (!spec.filtersByMake) continue;
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
              model: scalar(item.model) ?? parseModel(name, make),
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
      if (kmConverted) ctx.log(`${spec.id}: converted ${kmConverted} kilometre readings to miles`);

      return [...out.values()].map(makeListing) as Listing[];
    },
  };
}
