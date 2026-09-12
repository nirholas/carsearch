import type { Listing, SearchQuery, SourceAdapter, AdapterContext } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { isRoundedMileage, isValidVin } from '../core/normalize.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';

/**
 * Kelley Blue Book.
 *
 * Two things make this the most valuable adapter in the set.
 *
 * The first is the vehicle history preview. Every record carries a `vhrPreview`
 * array of report-backed flags, and it was present on 37 of 37 records in the
 * first sample. `owners` and `accidents` had roughly 1% and 0% coverage across
 * every other source in this project, because no other search-results payload
 * publishes them at all. Here they arrive with the listing, for free, on the
 * search page.
 *
 * The second is `pricingHistory`: dated asking prices going back to the day the
 * car was listed. Everywhere else, price history only exists for cars this
 * index happened to observe twice, so it starts empty and fills in slowly. KBB
 * hands over the whole series retrospectively.
 *
 * KBB is Cox Automotive, the same parent as Autotrader, and the images are
 * served from `atcimages.kbb.com` (atc for Autotrader Classifieds). This is
 * largely the inventory that Autotrader refuses us, reached through a door that
 * is open. Autotrader stays recorded as blocked; it is not needed.
 *
 * Transport: TLS fingerprint only. A plain fetch gets 403 and a real browser is
 * unnecessary, since the whole result set ships in `__NEXT_DATA__`.
 *
 * A note on slugs, which is the trap here. An unrecognised make or model slug
 * does NOT 404. `/cars-for-sale/used/norfolkkangaroo` answers 200 with a page
 * of Ford Mustangs and Kia Sorentos. Any adapter that trusted the URL it asked
 * for would file all of them under the requested make, which is exactly how
 * 159 Mustangs once entered this index labelled "G-Class". So: every record is
 * read for its own make and model, and anything off-make is dropped and
 * counted. A rotted slug therefore reports zero rather than quietly succeeding.
 */

interface KbbLabelled { label?: string; value?: string }
interface KbbCoded { code?: string; name?: string; description?: string; group?: string }

export interface KbbRecord {
  id?: number;
  vin?: string;
  year?: number;
  make?: KbbCoded;
  model?: KbbCoded;
  trim?: KbbCoded;
  mileage?: KbbLabelled;
  bodyStyles?: KbbCoded[];
  color?: { exteriorColor?: string; interiorColor?: string };
  transmission?: KbbCoded;
  driveType?: KbbCoded;
  fuelType?: KbbCoded;
  engine?: KbbCoded;
  doors?: number;
  mpgCity?: number;
  mpgHighway?: number;
  listingType?: string;
  ownerName?: string;
  daysOnSite?: number;
  stockId?: string;
  title?: string;
  titleLong?: string;
  vdpBaseUrl?: string;
  images?: { primary?: number; sources?: { src?: string }[] };
  /** Report-backed history flags. The reason this adapter exists. */
  vhrPreview?: string[];
  pricingHistory?: { dateUpdated?: string; price?: string }[];
  pricingDetail?: {
    displayPrice?: number;
    salePrice?: number;
    preFeeDerivedPrice?: number;
    /** KBB's own Fair Purchase Price and this car's distance from it. */
    kbbFppAmount?: number;
    kbbFppDelta?: number;
  };
}

/**
 * What the history flags actually assert, and nothing more.
 *
 * `NO_ONE_OWNER` says the car has had more than one owner but never how many,
 * so it yields null rather than a fabricated 2. `ACCIDENTS_REPORTED` likewise
 * gives the boolean without a count. `NO_SALVAGE_TITLE` is deliberately NOT
 * mapped to a clean title: "not salvage" leaves rebuilt, flood and lemon open,
 * and treating a partial assurance as a clean title is the exact mistake the
 * TitleStatus comment in facets.ts exists to prevent. `FREE_REPORT` is a
 * marketing badge, not a fact about the car.
 */
export function historyFacts(
  flags: string[] | undefined,
): Pick<Listing, 'owners' | 'accidents' | 'accidentFree' | 'titleStatus'> {
  const has = (f: string) => Array.isArray(flags) && flags.includes(f);

  /**
   * Frame damage outranks the accident count, and the two really do arrive
   * together. A live 2015 i8 published FRAME_DAMAGE and NO_ACCIDENTS_REPORTED
   * on the same record, priced $6,901 under KBB's own fair value. Reading only
   * the accident flag would have presented that car as accident-free, which is
   * the one lie this field exists to prevent. A car with a damaged frame is not
   * accident-free whatever the report says about claims, and the count is set
   * to null rather than zero because nobody stated one.
   */
  const frameDamage = has('FRAME_DAMAGE');
  const accidentsReported = has('ACCIDENTS_REPORTED') || frameDamage;
  const accidentFree = accidentsReported ? false : has('NO_ACCIDENTS_REPORTED') ? true : null;

  return {
    owners: has('ONE_OWNER') ? 1 : null,
    accidents: accidentFree === true ? 0 : null,
    accidentFree,
    titleStatus: titleFrom(flags),
  };
}

/**
 * The title brand a vehicle history preview states, or null.
 *
 * Only a positive brand is recorded. `NO_SALVAGE_TITLE` is deliberately NOT
 * read as `clean`: it says a salvage brand is absent, which is a narrower claim
 * than an unbranded title, and every other brand in TITLE_STATUSES is one this
 * source can be silent about. Answering "clean" from it would be the exact
 * conflation of "did not say" with "said clean" that the enum's own comment
 * warns about.
 *
 * Reading the positive brands still matters enormously: three live BMW i8s
 * published SALVAGE_TITLE, and the cheapest was being shown as a car whose
 * history nobody had published.
 */
export function titleFrom(flags: string[] | undefined): Listing['titleStatus'] {
  const has = (f: string) => Array.isArray(flags) && flags.includes(f);
  if (has('SALVAGE_TITLE')) return 'salvage';
  if (has('REBUILT_TITLE')) return 'rebuilt';
  if (has('FLOOD_WATER_DAMAGE')) return 'flood';
  if (has('LEMON_TITLE') || has('MANUFACTURER_BUYBACK')) return 'lemon';
  if (has('JUNK_TITLE')) return 'junk';
  if (has('THEFT_RECOVERY')) return 'theft-recovery';
  return null;
}

/** "2,960" -> 2960. Absent and unparseable both mean unknown, never zero. */
function miles(m: KbbLabelled | undefined): number | null {
  const n = Number(String(m?.value ?? '').replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "8-Cylinder Turbo" and "12-Cylinder Turbo" carry a cylinder count. */
function cylinders(engine: string | undefined): number | null {
  const m = engine?.match(/\b(\d{1,2})[\s-]?cylinder\b/i);
  return m ? Number(m[1]) : null;
}

/**
 * `titleLong` is `title` plus the location: "Used 2020 McLaren 720S Performance
 * Scottsdale AZ 85260". Subtracting one from the other is the only place the
 * city appears on a search record.
 */
export function location(r: KbbRecord): string | null {
  const long = r.titleLong?.trim();
  const short = r.title?.trim();
  if (!long) return null;
  const rest = short && long.startsWith(short) ? long.slice(short.length).trim() : '';
  return rest || null;
}

/** "07.28.2026" -> "2026-07-28". Anything else is dropped rather than guessed. */
function historyDate(s: string | undefined): string | null {
  const m = s?.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

/**
 * Retrospective asking prices, oldest first.
 *
 * The final entry is labelled "Price Today" rather than dated, and it duplicates
 * the current price, so it is dropped: the crawler records today's price itself,
 * with a timestamp it can vouch for.
 */
export function priceHistory(r: KbbRecord): { observedAt: string; price: number }[] | null {
  const out: { observedAt: string; price: number }[] = [];
  for (const p of r.pricingHistory ?? []) {
    const observedAt = historyDate(p.dateUpdated);
    const price = Number(String(p.price ?? '').replace(/[^\d]/g, ''));
    if (observedAt && Number.isFinite(price) && price > 0) out.push({ observedAt, price });
  }
  return out.length ? out.sort((a, b) => a.observedAt.localeCompare(b.observedAt)) : null;
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Make names for comparison only, never for storage.
 *
 * KBB writes "Mercedes-Benz", "Land Rover" and "Rolls-Royce"; a query may
 * reasonably arrive as any of "mercedes benz", "Mercedes-Benz" or "landrover".
 * Comparing those literally makes the off-make guard reject an entire correct
 * result set, which is worse than the poisoning it exists to prevent: the guard
 * would report "slug is wrong" on a slug that was right.
 */
export function sameMake(a: string | undefined, b: string): boolean {
  const key = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  return a !== undefined && key(a) === key(b);
}

const PAGE_SIZE = 100;

/**
 * How deep to walk one query.
 *
 * This was the literal `3` in the page loop below, which is 300 records, and
 * KBB is the largest catalogue the index reaches: its own results header reads
 * "10,674 Matches" for a nationwide Macan search. Three pages of it is 2.8% of
 * the inventory, and the 97% left behind is not a random sample, because the
 * default sort is relevance rather than price. The cheap cars are exactly the
 * ones that sort last, so the floor this source reported was an artifact of
 * where the loop stopped rather than a fact about the market.
 *
 * A ceiling, not an expectation. The loop already exits on the first page that
 * adds no new car and on any short page, so a model with forty cars still costs
 * one request. This only has to be larger than the biggest real catalogue.
 */
const MAX_PAGES = 150;

/** Pulls the whole search response out of the Next.js page payload. */
export function inventoryFrom(html: string): KbbRecord[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m?.[1]) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const inv = (parsed as { props?: { pageProps?: { __eggsState?: { inventory?: Record<string, KbbRecord> } } } })
    ?.props?.pageProps?.__eggsState?.inventory;
  return inv ? Object.values(inv) : [];
}

function url(query: SearchQuery, model: string | undefined, firstRecord: number, band?: Band): string {
  const path = [slug(query.make ?? ''), model ? slug(model) : ''].filter(Boolean).join('/');
  const params = new URLSearchParams({ numRecords: String(PAGE_SIZE), firstRecord: String(firstRecord) });
  if (query.zip) params.set('zip', query.zip);
  // KBB reads radius 0 as nationwide, which is what an index wants by default.
  params.set('searchRadius', query.radius === 'any' || query.radius === undefined ? '0' : String(query.radius));
  /**
   * `startYear` and `endYear`, not `yearMin`/`yearMax`.
   *
   * The wrong names are not rejected, they are ignored, so the crawl looked
   * like it was banding by year while every band returned the same newest slice.
   * Measured on Porsche: an unfiltered query returns 125 cars spanning 2007 to
   * 2026 and NOT ONE older than 2000, while `endYear=1999` returns 117 of which
   * 105 are pre-2000. The result set is capped, so the cap alone decides what
   * comes back, and what comes back is always the newest. Year banding is
   * therefore the only route to old inventory, not a refinement of it.
   */
  if (query.yearMin) params.set('startYear', String(query.yearMin));
  if (query.yearMax) params.set('endYear', String(query.yearMax));
  /**
   * `maxPrice`/`minPrice`, not `priceMax`/`priceMin`.
   *
   * The same trap as the year names above, and this one was live: `priceMax`
   * is not rejected, it is ignored. Measured on the same Macan query,
   * `priceMax=35000` returns the unfiltered 4,604 matches while
   * `maxPrice=35000` returns 154. Every price-capped KBB search ever run by
   * this adapter was therefore an uncapped one.
   */
  const lo = band ? band[0] : query.priceMin;
  const hi = band ? band[1] : query.priceMax;
  if (lo) params.set('minPrice', String(lo));
  if (hi) params.set('maxPrice', String(hi));
  if (query.mileageMax) params.set('maxMileage', String(query.mileageMax));
  return `https://www.kbb.com/cars-for-sale/used/${path}?${params}`;
}

/** A price slice, in dollars. `null` for the top band means no upper bound. */
type Band = [number, number | null];

/**
 * How many records KBB will actually page through before it starts lying.
 *
 * Past roughly this depth `firstRecord` stops advancing and the site re-serves
 * the top of the result set instead of erroring. Measured: `firstRecord=200`
 * shares 13 of 125 records with page zero, while `firstRecord=500` shares 113
 * and `firstRecord=1000` shares 112. So a deep walk of a big result set is not
 * slow, it is fictional: one Macan run fetched 5,507 on-make records and held
 * 481 distinct ones, because every page past the fourth was a re-run of the
 * first.
 *
 * Raising MAX_PAGES cannot fix that. The only way to reach the whole catalogue
 * is to ask smaller questions, which is what the band splitting below does.
 */
const DEEP_PAGE_CAP = 350;

/** The smallest band worth splitting further, in dollars. */
const MIN_BAND = 1_000;

/** What the results header claims, which is the whole catalogue and not a page. */
export function matchCount(html: string): number | null {
  const m = html.match(/id="results-count"[^>]*>\s*([\d,]+)\s*Matches/i);
  return m?.[1] ? Number(m[1].replace(/,/g, '')) : null;
}

/**
 * Split a band that is too deep to page, in two.
 *
 * The top band has no upper bound, so it is split at a multiple of its floor
 * rather than at a midpoint that does not exist. Returns null when the band is
 * already too narrow to be worth dividing, in which case the caller pages what
 * it can and says so.
 */
/** A band, written the way a person reads a price range. */
function bandLabel([lo, hi]: Band): string {
  return `$${(lo / 1000).toFixed(0)}k-${hi === null ? 'up' : `$${(hi / 1000).toFixed(0)}k`}`;
}

export function splitBand([lo, hi]: Band): [Band, Band] | null {
  if (hi === null) return [[lo, lo > 0 ? lo * 2 : 25_000], [lo > 0 ? lo * 2 : 25_000, null]];
  if (hi - lo <= MIN_BAND) return null;
  const mid = Math.round((lo + hi) / 2 / 100) * 100;
  if (mid <= lo || mid >= hi) return null;
  return [[lo, mid], [mid, hi]];
}

export function toDraft(r: KbbRecord, now: string): ListingDraft | null {
  if (!r.id || !r.make?.name) return null;
  const p = r.pricingDetail ?? {};
  const engine = r.engine?.name ?? null;
  const img = r.images?.sources?.[r.images.primary ?? 0]?.src ?? r.images?.sources?.[0]?.src ?? null;
  const mileage = miles(r.mileage);

  return {
    id: `kbb:${r.id}`,
    sourceId: 'kbb',
    sourceListingId: String(r.id),
    url: r.vdpBaseUrl ? `https://www.kbb.com${r.vdpBaseUrl}` : `https://www.kbb.com/cars-for-sale/vehicle/${r.id}`,
    title: r.title ?? [r.year, r.make.name, r.model?.name, r.trim?.name].filter(Boolean).join(' '),
    year: r.year ?? null,
    make: r.make.name,
    model: r.model?.name ?? null,
    trim: r.trim?.name ?? null,
    vin: isValidVin(r.vin) ? r.vin!.toUpperCase() : null,

    /**
     * The advertised price, not the all-in price. `displayPrice` folds in
     * documentation and title fees when a dealer opts into all-in pricing, and
     * comparing one source's out-the-door number against another's sticker is a
     * silent apples-to-oranges error. Both are kept; only the sticker is ranked.
     */
    price: p.salePrice ?? p.preFeeDerivedPrice ?? p.displayPrice ?? null,
    priceKind: 'ask',
    currency: 'USD',

    mileage,
    mileageIsRounded: isRoundedMileage(mileage),
    location: location(r),
    sellerType: 'dealer',
    bodyType: r.bodyStyles?.[0]?.name ?? null,
    exteriorColor: r.color?.exteriorColor ?? null,
    interiorColor: r.color?.interiorColor ?? null,
    fuelType: r.fuelType?.name ?? null,
    imageUrl: img,

    ...historyFacts(r.vhrPreview),

    transmission: parseTransmission(r.transmission?.description ?? r.transmission?.name),
    drivetrain: parseDrivetrain(r.driveType?.name ?? r.driveType?.description),
    engine,
    cylinders: cylinders(engine ?? undefined),
    doors: r.doors ?? null,
    mpgCity: r.mpgCity ?? null,
    mpgHighway: r.mpgHighway ?? null,
    certified: r.listingType === 'CERTIFIED',
    dealerName: r.ownerName ?? null,

    priceHistory: priceHistory(r),

    firstSeen: now,
    lastSeen: now,
    raw: {
      /**
       * KBB's Fair Purchase Price is kept and never ranked on, for the same
       * reason CarGurus' deal rating is: it is their valuation, and holding
       * both lets a listing read "below KBB, still above what these actually
       * sell for". Ours is computed from completed sales.
       */
      kbbFairPurchasePrice: p.kbbFppAmount,
      kbbFairPurchaseDelta: p.kbbFppDelta,
      allInPrice: p.displayPrice,
      /** KBB's own days-on-lot, which predates anything this index observed. */
      kbbDaysOnSite: r.daysOnSite,
      kbbStockId: r.stockId,
      vhrPreview: r.vhrPreview,
    },
  };
}

export const kbb: SourceAdapter = {
  source: getSource('kbb')!,

  async search(query: SearchQuery, ctx: AdapterContext): Promise<Listing[]> {
    if (!query.make) {
      ctx.log('kbb: needs a make, skipping');
      return [];
    }
    const now = new Date().toISOString();
    const wanted = query.make;
    const out = new Map<string, ListingDraft>();
    const models: (string | undefined)[] = query.models?.length ? query.models : [undefined];

    for (const model of models) {
      let offMake = 0;
      let onMake = 0;

      /**
       * Bands still to walk, deepest-first off the end of the array.
       *
       * Seeded with whatever the caller asked for, so a query that already
       * carries a price range is split inside that range rather than around it.
       */
      const queue: Band[] = [[query.priceMin ?? 0, query.priceMax ?? null]];
      let requests = 0;
      let split = 0;

      while (queue.length && requests < MAX_PAGES) {
        const band = queue.pop()!;

        for (let page = 0; page < MAX_PAGES && requests < MAX_PAGES; page++) {
          const target = url(query, model, page * PAGE_SIZE, band);
          let records: KbbRecord[];
          let total: number | null = null;
          try {
            const res = await fetchWithTls(target, {}, { browser: 'chrome' });
            requests += 1;
            if (res.status !== 200) {
              ctx.log(`kbb ${model ?? 'all'} ${bandLabel(band)} page ${page}: HTTP ${res.status}`);
              break;
            }
            records = inventoryFrom(res.body);
            total = matchCount(res.body);
          } catch (e) {
            ctx.log(`kbb ${model ?? 'all'} ${bandLabel(band)} page ${page} FAILED: ${(e as Error).message.split('\n')[0]}`);
            break;
          }

          // Too deep to page honestly. Halve it and come back to both halves
          // rather than walking pages that re-serve the first one.
          if (page === 0 && total !== null && total > DEEP_PAGE_CAP) {
            const halves = splitBand(band);
            if (halves) {
              queue.push(halves[0], halves[1]);
              split += 1;
              break;
            }
            // Unsplittable and over the cap: page what is reachable and say so.
            ctx.log(`kbb ${model ?? 'all'} ${bandLabel(band)}: ${total} cars in a band too narrow to split, reading the first ${DEEP_PAGE_CAP}`);
          }

          if (records.length === 0) break;

          let added = 0;
          for (const r of records) {
            // An unrecognised slug answers 200 with unrelated cars. Trust the
            // record, never the URL that was requested.
            if (!sameMake(r.make?.name, wanted)) {
              offMake++;
              continue;
            }
            onMake++;
            const draft = toDraft(r, now);
            if (!draft || out.has(draft.id)) continue;
            out.set(draft.id, draft);
            added++;
          }
          if (added === 0) break;
          if (records.length < PAGE_SIZE) break;
        }
      }

      ctx.log(`kbb ${(model ?? 'all').padEnd(12)} ${requests} requests, ${split} bands split, pool ${out.size}`);

      if (onMake === 0 && offMake > 0) {
        ctx.log(`kbb ${model ?? 'all'}: slug returned ${offMake} cars, none of them ${query.make}. Slug is wrong.`);
      } else {
        const withHistory = [...out.values()].filter((d) => d.priceHistory?.length).length;
        const withVhr = [...out.values()].filter((d) => d.accidentFree !== null || d.owners !== null).length;
        ctx.log(
          `kbb ${(model ?? 'all').padEnd(12)} ${String(onMake).padStart(3)} on-make, ${offMake} dropped ` +
            `(pool ${out.size}, ${withVhr} with history report, ${withHistory} with price history)`,
        );
      }
    }

    return [...out.values()].map(makeListing);
  },
};
