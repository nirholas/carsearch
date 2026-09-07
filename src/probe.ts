import { SOURCES } from './sources/registry.js';
import { probe as browserProbe } from './transport/browser.js';
import type { Source, Transport } from './core/types.js';

/**
 * Reachability prober.
 *
 * This is the single most valuable maintenance tool in the project. Bot
 * defenses change without notice, and when they do a scraper does not error, it
 * returns nothing. A silently empty result set looks exactly like a market with
 * no matching cars. Running this on a schedule turns that into a visible
 * green-to-red transition.
 *
 * It tests BOTH transports on every source, because the two disagree in both
 * directions and neither predicts the other. That finding is the reason the
 * fetcher has two transports at all.
 */

export interface ProbeResult {
  sourceId: string;
  name: string;
  declared: Transport;
  fetch: { status: number | string; blocked: boolean; bytes: number; priceHits: number; jsonLd: number; isJson: boolean };
  browser: { status: number | string; blocked: boolean; priceHits: number; jsonLd: number; textLength: number };
  /** What the transport SHOULD be declared as, given what we just measured. */
  observed: Transport;
  drifted: boolean;
}

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const BLOCK_TEXT =
  /access denied|are you a human|unusual traffic|verify you are|pardon our interruption|captcha|cf-browser-verification|just a moment/i;

async function probeFetch(url: string): Promise<ProbeResult['fetch']> {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const body = await res.text();
    return {
      status: res.status,
      blocked: !res.ok || BLOCK_TEXT.test(body.slice(0, 4000)),
      bytes: body.length,
      priceHits: (body.match(/\$\d{2},\d{3}/g) ?? []).length,
      jsonLd: (body.match(/application\/ld\+json/g) ?? []).length,
      isJson: looksLikeJson(res.headers.get('content-type'), body),
    };
  } catch (e) {
    return {
      status: (e as Error).name === 'TimeoutError' ? 'TIMEOUT' : 'ERR',
      blocked: true,
      bytes: 0,
      priceHits: 0,
      jsonLd: 0,
      isJson: false,
    };
  }
}

function looksLikeJson(contentType: string | null, body: string): boolean {
  if (contentType?.includes('json')) return true;
  const t = body.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

/** A URL that actually exercises a source's search results, not its marketing home page. */
function probeUrl(s: Source): string {
  const custom: Record<string, string> = {
    autotempest: 'https://www.autotempest.com/results?make=porsche&maxprice=40000&zip=92101&radius=any',
    carmax: 'https://www.carmax.com/cars/porsche',
    carscom:
      'https://www.cars.com/shopping/results/?stock_type=used&makes[]=porsche&maximum_distance=all&zip=92101&list_price_max=40000',
    cargurus: 'https://www.cargurus.com/Cars/l-Used-Porsche-San-Diego-m48_L2362',
    autotrader: 'https://www.autotrader.com/cars-for-sale/porsche?searchRadius=0&maxPrice=40000',
    bringatrailer: 'https://bringatrailer.com/porsche/macan/',
    carsandbids: 'https://carsandbids.com/past-auctions/?q=porsche',
    pcarmarket: 'https://www.pcarmarket.com/auction/',
    tesla: 'https://www.tesla.com/inventory/used/m3',
    copart: 'https://www.copart.com/lotSearchResults?free=true&query=porsche',
    hemmings: 'https://www.hemmings.com/classifieds/for-sale/porsche',
    edmunds: 'https://www.edmunds.com/used-porsche/',
    truecar: 'https://www.truecar.com/used-cars-for-sale/listings/porsche/',
    carvana: 'https://www.carvana.com/cars/porsche',
    carsforsale: 'https://www.carsforsale.com/porsche-for-sale',
    porschefinder: 'https://finder.porsche.com/us/en-US/search',
    echopark: 'https://www.echopark.com/inventory?make=Porsche',
    autonation: 'https://www.autonation.com/used-cars/porsche',
    carfax: 'https://www.carfax.com/Used-Porsche_m28',
    dupontregistry: 'https://www.dupontregistry.com/autos/results/porsche/all/all',
    govdeals: 'https://www.govdeals.com/index.cfm?fa=Main.AdvSearchResultsNew&searchPg=Category&kWord=car',
    vpic: 'https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/WP1AB2A56LLB33982?format=json',
    'nhtsa-recalls': 'https://api.nhtsa.gov/recalls/recallsByVehicle?make=porsche&model=taycan&modelYear=2021',
    fueleconomy: 'https://www.fueleconomy.gov/ws/rest/vehicle/menu/make?year=2020',
  };
  return custom[s.id] ?? s.homepage;
}

/**
 * A 200 is not the same as usable data.
 *
 * Plenty of sites answer a plain request with an empty JavaScript shell: real
 * status, real bytes, zero listings. Treating that as reachable is how a source
 * gets declared 'fetch', silently returns nothing, and then looks like a market
 * with no cars in it rather than a broken adapter. So reachability requires a
 * content signal, and what counts as a signal depends on what the source is.
 *
 * Raw HTML bytes are not a signal on the fetch path, because a shell page is
 * mostly JavaScript and easily clears any byte threshold. Rendered text length
 * IS a signal on the browser path, because it only counts what a human would
 * see. A JSON API has neither prices nor structured-data blocks and is judged
 * purely on whether it returned parseable JSON.
 */
function fetchHasSignal(r: ProbeResult['fetch'], isApi: boolean): boolean {
  if (r.blocked) return false;
  if (isApi) return r.isJson;
  return r.priceHits >= 3 || r.jsonLd >= 1;
}

function browserHasSignal(r: ProbeResult['browser'], isApi: boolean): boolean {
  if (r.blocked || r.status !== 200) return false;
  if (isApi) return r.textLength > 100;
  return r.priceHits >= 3 || r.jsonLd >= 1 || r.textLength > 15000;
}

function observedTransport(r: Omit<ProbeResult, 'observed' | 'drifted'>, isApi: boolean): Transport {
  const fetchOk = fetchHasSignal(r.fetch, isApi);
  const browserOk = browserHasSignal(r.browser, isApi);

  /**
   * Both transports can return 200 with real content while one of them is a
   * teaser. AutoTempest serves a plain request four prices and a real browser
   * 289 of them. Declaring that 'either' would make the cheap transport win and
   * quietly cost 98% of the results, which is worse than declaring it blocked
   * because it still looks like it works.
   *
   * So when both succeed, the weaker one has to be within a fraction of the
   * stronger one to count as equivalent.
   */
  if (fetchOk && browserOk && !isApi) {
    const f = r.fetch.priceHits;
    const b = r.browser.priceHits;
    if (b > 0 && f < b * 0.2) return 'browser';
    if (f > 0 && b < f * 0.2) return 'fetch';
  }

  if (fetchOk && browserOk) return 'either';
  if (fetchOk) return 'fetch';
  if (browserOk) return 'browser';
  return 'blocked';
}

export async function probeSources(ids?: string[]): Promise<ProbeResult[]> {
  const targets = ids?.length ? SOURCES.filter((s) => ids.includes(s.id)) : SOURCES.filter((s) => s.status !== 'planned');
  const out: ProbeResult[] = [];

  for (const s of targets) {
    const url = probeUrl(s);
    const f = await probeFetch(url);
    const b = await browserProbe(url);
    const partial = {
      sourceId: s.id,
      name: s.name,
      declared: s.transport,
      fetch: f,
      browser: {
        status: b.status,
        blocked: b.blocked || b.status !== 200,
        priceHits: b.priceHits,
        jsonLd: b.jsonLd,
        textLength: b.textLength,
      },
    };
    const observed = observedTransport(partial, s.access === 'api' || s.access === 'feed');
    out.push({ ...partial, observed, drifted: observed !== s.transport && s.transport !== 'either' });
  }

  return out;
}

export function formatProbeTable(results: ProbeResult[]): string {
  const lines = [
    'source          declared   fetch                browser                          observed   drift',
    '--------------- ---------- -------------------- -------------------------------- ---------- -----',
  ];
  for (const r of results) {
    const f = `${String(r.fetch.status).padEnd(5)}${r.fetch.blocked ? 'BLK' : 'ok '} $${String(r.fetch.priceHits).padStart(3)} ld${String(r.fetch.jsonLd).padStart(2)}`;
    const b = `${String(r.browser.status).padEnd(6)}${r.browser.blocked ? 'BLOCK' : 'ok   '} $${String(r.browser.priceHits).padStart(3)} ld${String(r.browser.jsonLd).padStart(3)} len${String(r.browser.textLength).padStart(7)}`;
    lines.push(
      `${r.sourceId.padEnd(15)} ${r.declared.padEnd(10)} ${f.padEnd(20)} ${b.padEnd(32)} ${r.observed.padEnd(10)} ${r.drifted ? 'DRIFT' : ''}`,
    );
  }
  return lines.join('\n');
}
