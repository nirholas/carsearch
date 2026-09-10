import type { Listing, SearchQuery, SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { evaluateInPage } from '../transport/browser.js';
import { isRoundedMileage, isValidVin } from '../core/normalize.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';

/**
 * CarGurus.
 *
 * Do not scrape the rendered tiles. The page is a Remix application and ships
 * its entire search response as JSON on `window.__remixContext`, which carries
 * far more than the markup shows: the VIN, exact mileage, trim, body type,
 * drivetrain, colours, days on market and CarGurus' own deal rating. The DOM
 * renders 21 tiles where the payload holds 24.
 *
 * The VIN matters most. CarGurus becomes the second source after CarMax that
 * deduplicates exactly rather than by composite key, which is what lets the
 * index prove the same car is listed in two places instead of guessing.
 *
 * Their deal rating is kept rather than used. It is computed against other
 * asking prices, the comparison this project exists to replace, so holding both
 * lets a listing read "rated FAIR_PRICE there, above market against real sales".
 *
 * URLs need CarGurus' own make and model codes (Porsche is m48, Macan d2261).
 * Those are derived at runtime from the same payload rather than hardcoded,
 * because a table of a hundred codes is exactly the thing that rots silently.
 */

interface OntologyData {
  makeName?: string;
  modelName?: string;
  carYear?: string;
  trimName?: string;
  bodyTypeName?: string;
}

interface TileData {
  id?: number;
  vin?: string;
  listingTitle?: string;
  daysOnMarket?: number;
  dealRating?: string;
  isCpo?: boolean;
  isNew?: boolean;
  mileageData?: { value?: number };
  priceData?: { current?: number; totalPrice?: number };
  ontologyData?: OntologyData;
  pictureData?: { url?: string };
  exteriorColorData?: { localized?: string; normalized?: string };
  interiorColorData?: { localized?: string; normalized?: string };
  fuelData?: { localizedType?: string; cityEconomy?: number; highwayEconomy?: number; combinedEconomy?: number };
  evBatteryData?: { batterySize?: number; range?: number; localizedRange?: string };
  localizedDrivetrain?: string;
  /** "8-Speed Automatic", "7-Speed Dual Clutch", "6-Speed Manual". */
  localizedTransmission?: string;
  /** "4 doors". */
  localizedDoors?: string;
  /** "300 hp 2.5L I4". */
  localizedEngineName?: string;
  vehicleFeatures?: string[] | { name?: string }[];
  sellerData?: { name?: string; city?: string; state?: string; rating?: number };
}

/** "300 hp 2.5L I4" carries a cylinder count and a displacement worth having. */
function engineFacts(name: string | undefined): { cylinders: number | null; displacementL: number | null } {
  if (!name) return { cylinders: null, displacementL: null };
  const cyl = name.match(/\b[IVHWB](\d{1,2})\b/i) ?? name.match(/\b(\d{1,2})[\s-]?cyl/i);
  const disp = name.match(/\b(\d(?:\.\d)?)\s?L\b/i);
  return {
    cylinders: cyl?.[1] ? Number(cyl[1]) : null,
    displacementL: disp?.[1] ? Number(disp[1]) : null,
  };
}

function featureList(v: TileData['vehicleFeatures']): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const names = v
    .map((f) => (typeof f === 'string' ? f : f?.name))
    .filter((f): f is string => typeof f === 'string' && f.length > 0);
  return names.length ? names : null;
}

interface Filter {
  name?: string;
  label?: string;
  value?: string;
  filters?: Filter[];
}

/** Runs in the page. Pulls both the listings and the code table from one payload. */
const EXTRACT = () => {
  const ctx = (window as unknown as { __remixContext?: { state?: { loaderData?: Record<string, unknown> } } }).__remixContext;
  const loader = ctx?.state?.loaderData ?? {};
  const key = Object.keys(loader).find((k) => k.includes('Cars') && k.includes('seoPath'));
  if (!key) return { tiles: [] as TileData[], makes: [] as Filter[] };
  const search = (loader[key] as Record<string, unknown>).search as Record<string, unknown> | undefined;
  const tiles = ((search?.tiles as { data?: TileData }[]) ?? []).map((t) => t.data ?? {});
  const makes = (((search?.filters as Record<string, unknown>)?.MAKE_MODEL as Record<string, unknown>)?.filters as Filter[]) ?? [];
  return { tiles, makes };
};

/** make name (lowercase) -> { code, models: { model name (lowercase) -> code } } */
type CodeTable = Map<string, { code: string; models: Map<string, string> }>;
let codeTable: CodeTable | null = null;

function buildCodeTable(makes: Filter[]): CodeTable {
  const table: CodeTable = new Map();
  for (const m of makes) {
    if (!m.label || !m.value) continue;
    const models = new Map<string, string>();
    for (const mod of m.filters ?? []) {
      // A model value looks like "m48/d2261"; only the model half filters correctly.
      const code = mod.value?.split('/').pop();
      if (mod.label && code) models.set(mod.label.toLowerCase(), code);
    }
    table.set(m.label.toLowerCase(), { code: m.value, models });
  }
  return table;
}

const SEED_URL = 'https://www.cargurus.com/Cars/l-Used-Porsche-m48';

/**
 * A ceiling, not an expectation. The loop exits on a page that adds no cars.
 *
 * CarGurus paginates with `#resultsPage=N` and the adapter read only the first
 * page, so every car past the first tile set was invisible. A source that is
 * silently truncated is indistinguishable from a source with thin inventory,
 * which is exactly how this survived.
 */
const MAX_PAGES = 60;

function slug(s: string): string {
  return s.replace(/\s+/g, '-');
}

export const cargurus: SourceAdapter = {
  source: getSource('cargurus')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();

    // One seed load populates the code table for every make and model.
    if (!codeTable) {
      const seed = await evaluateInPage(SEED_URL, EXTRACT, { waitMs: 5500, scroll: false });
      codeTable = buildCodeTable(seed.makes);
      ctx.log(`cargurus: learned ${codeTable.size} make codes from the search payload`);
    }

    const make = query.make?.toLowerCase();
    const entry = make ? codeTable.get(make) : undefined;
    if (make && !entry) {
      ctx.log(`cargurus: no code for make "${query.make}", skipping`);
      return [];
    }

    const targets: { url: string; model?: string }[] = [];
    if (entry && query.models?.length) {
      for (const model of query.models) {
        const code = entry.models.get(model.toLowerCase());
        if (!code) {
          ctx.log(`cargurus: no code for model "${model}", skipping it`);
          continue;
        }
        targets.push({ url: `https://www.cargurus.com/Cars/l-Used-${slug(query.make!)}-${slug(model)}-${code}`, model });
      }
    } else if (entry) {
      targets.push({ url: `https://www.cargurus.com/Cars/l-Used-${slug(query.make!)}-${entry.code}` });
    } else {
      return [];
    }

    for (const target of targets) {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
      const before = out.size;
      try {
        const pageUrl = page === 1 ? target.url : `${target.url}?page=${page}#resultsPage=${page}`;
        const { tiles } = await evaluateInPage(pageUrl, EXTRACT, { waitMs: 6000, scroll: false });
        if (tiles.length === 0) break;

        for (const t of tiles) {
          // Ad tiles carry no ontology and no id; they are not inventory.
          if (!t.id || !t.ontologyData?.makeName) continue;
          const id = `cargurus:${t.id}`;
          if (out.has(id)) continue;

          const o = t.ontologyData;
          const miles = t.mileageData?.value ?? null;
          const seller = t.sellerData;
          out.set(id, {
            id,
            sourceId: 'cargurus',
            sourceListingId: String(t.id),
            url: `https://www.cargurus.com/Cars/link/${t.id}`,
            title: [o.carYear, o.makeName, o.modelName, o.trimName].filter(Boolean).join(' '),
            year: o.carYear ? Number(o.carYear) : null,
            make: o.makeName ?? null,
            model: o.modelName ?? target.model ?? null,
            trim: o.trimName ?? null,
            series: null,
            vin: isValidVin(t.vin) ? t.vin.toUpperCase() : null,
            // The headline price, not the price including fees: every other
            // source publishes the advertised number, and comparing one
            // source's out-the-door price against another's sticker is a
            // silent apples-to-oranges error.
            price: t.priceData?.current ?? null,
            priceKind: 'ask',
            currency: 'USD',
            mileage: miles,
            mileageIsRounded: isRoundedMileage(miles),
            location: seller?.city ? `${seller.name ?? 'dealer'} (${seller.city}, ${seller.state ?? ''})`.trim() : (seller?.name ?? null),
            sellerType: 'dealer',
            bodyType: o.bodyTypeName ?? null,
            exteriorColor: t.exteriorColorData?.localized ?? null,
            interiorColor: t.interiorColorData?.localized ?? null,
            fuelType: t.fuelData?.localizedType ?? null,
            eventDate: null,
            imageUrl: t.pictureData?.url ?? null,

            /**
             * Every tile already carries these. They were previously dropped
             * into `raw` or discarded, which meant a search could not filter on
             * a drivetrain the source had literally handed us, and the VIN
             * decoder was being asked for facts already on the page.
             */
            transmission: parseTransmission(t.localizedTransmission),
            drivetrain: parseDrivetrain(t.localizedDrivetrain),
            engine: t.localizedEngineName ?? null,
            ...engineFacts(t.localizedEngineName),
            doors: t.localizedDoors ? Number(t.localizedDoors.replace(/\D/g, '')) || null : null,
            mpgCity: t.fuelData?.cityEconomy ?? null,
            mpgHighway: t.fuelData?.highwayEconomy ?? null,
            rangeMiles: t.evBatteryData?.range ?? null,
            batteryKwh: t.evBatteryData?.batterySize ?? null,
            certified: t.isCpo ?? null,
            dealerName: seller?.name ?? null,
            dealerRating: seller?.rating ?? null,
            options: featureList(t.vehicleFeatures),

            firstSeen: now,
            lastSeen: now,
            raw: {
              // Their rating is kept, never used: it compares a listing to other
              // asking prices, which is the comparison this project replaces.
              cargurusDealRating: t.dealRating,
              cargurusDaysOnMarket: t.daysOnMarket,
              totalPriceWithFees: t.priceData?.totalPrice,
            },
          });
        }
        const vins = tiles.filter((t) => isValidVin(t.vin)).length;
        const added = out.size - before;
        ctx.log(
          `cargurus ${(target.model ?? 'all').padEnd(12)} p${page} +${String(tiles.length).padStart(3)} tiles, ` +
          `${vins} with VIN, ${added} new (pool ${out.size})`,
        );
        // The pager re-serves its last page rather than emptying, so a page
        // that contributes nothing is the only reliable end.
        if (added === 0) break;
      } catch (e) {
        ctx.log(`cargurus ${target.model ?? 'all'} p${page} FAILED: ${(e as Error).message.split('\n')[0]}`);
        break;
      }
      }
    }

    return [...out.values()].map(makeListing);
  },
};
