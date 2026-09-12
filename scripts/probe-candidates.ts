import { fetchWithTls } from '../src/transport/tls.js';
import { extractJsonLd, vehicleNodes, offerPrice, scalar } from '../src/sources/jsonld.js';
import { findRecords } from '../src/sources/nextjs.js';

/**
 * Probes a candidate's SEARCH page and says which reader would wire it.
 *
 * The registry sweep reads homepages, which answers "is this host reachable"
 * and never "can its inventory be read": a homepage carries no cars, so a
 * source whose search page ships a full catalogue scores zero there. This asks
 * the question that actually decides the work, and reports the answer in the
 * three shapes the codebase already has readers for.
 */

const MARKERS = [
  'vin', 'mileage', 'odometer', 'listingId', 'stockNumber', 'askingPrice',
  'price', 'salePrice', 'currentBid', 'hammerPrice', 'modelYear', 'year', 'makeName',
];

/** Candidate search URLs, one per source, for a make the site is likely to hold. */
const CANDIDATES: [string, string][] = [
  ['carsforsale', 'https://www.carsforsale.com/porsche-for-sale'],
  ['edmunds', 'https://www.edmunds.com/porsche/'],
  ['autolist', 'https://www.autolist.com/porsche'],
  ['echopark', 'https://www.echopark.com/inventory?make=Porsche'],
  ['autonation', 'https://www.autonation.com/cars/porsche'],
  ['carsoup', 'https://www.carsoup.com/for-sale/used/porsche/'],
  ['jamesedition', 'https://www.jamesedition.com/cars/porsche'],
  ['exoticcartrader', 'https://www.exoticcartrader.com/inventory'],
  ['classicdriver', 'https://www.classicdriver.com/en/cars/porsche'],
  ['poctra', 'https://poctra.com/search?q=porsche'],
  ['iaai', 'https://www.iaai.com/Search?url=eyJUYWdOYW1lIjoibWFrZSJ9'],
  ['bonhamscars', 'https://cars.bonhams.com/en/search?q=porsche'],
  ['broadarrow', 'https://www.broadarrowauctions.com/auctions'],
  ['goodingco', 'https://www.goodingco.com/past-auction-results'],
  ['govdeals', 'https://www.govdeals.com/en/search/filters?searchQuery=porsche'],
  ['publicsurplus', 'https://www.publicsurplus.com/sms/browse/cataucs?catid=4'],
  ['municibid', 'https://municibid.com/browse/vehicles'],
  ['mobilede', 'https://suchen.mobile.de/fahrzeuge/search.html?makeModelVariant1.makeId=20100'],
  ['lacentrale', 'https://www.lacentrale.fr/listing?makesModelsCommercialNames=PORSCHE'],
  ['leboncoin', 'https://www.leboncoin.fr/recherche?category=2&text=porsche'],
  ['cochesnet', 'https://www.coches.net/porsche-ocasion/'],
  ['subito', 'https://www.subito.it/annunci-italia/vendita/auto/?q=porsche'],
  ['marktplaats', 'https://www.marktplaats.nl/l/auto-s/porsche/'],
  ['otomoto', 'https://www.otomoto.pl/osobowe/porsche'],
  ['mobilebg', 'https://www.mobile.bg/obiavi/avtomobili-dzhipove/porsche'],
  ['sahibinden', 'https://www.sahibinden.com/porsche'],
  ['kijijiautos', 'https://www.kijijiautos.ca/cars/porsche/'],
  ['carsalesau', 'https://www.carsales.com.au/cars/porsche/'],
  ['trademe', 'https://www.trademe.co.nz/a/motors/cars/porsche/search'],
  ['goonet', 'https://www.goo-net.com/usedcar/brand-PORSCHE/car-911/'],
  ['carsensor', 'https://www.carsensor.net/usedcar/bPO/s039/index.html'],
  ['encar', 'http://www.encar.com/dc/dc_carsearchlist.do'],
  ['carsome', 'https://www.carsome.my/buy-car?make=porsche'],
  ['sgcarmart', 'https://www.sgcarmart.com/used_cars/listing.php?BRSR=0&MOD=porsche'],
  ['dubizzle', 'https://dubai.dubizzle.com/motors/used-cars/porsche/'],
  ['kavak', 'https://www.kavak.com/mx/autos-seminuevos-y-usados-porsche'],
  ['webmotors', 'https://www.webmotors.com.br/carros/estoque/porsche'],
  ['autotraderza', 'https://www.autotrader.co.za/cars-for-sale/porsche'],
  ['autotraderuk', 'https://www.autotrader.co.uk/car-search?make=PORSCHE'],
  ['recurrent', 'https://www.recurrentauto.com/marketplace'],
  ['porschefinder', 'https://finder.porsche.com/us/en-US/search'],
  ['mbusacpo', 'https://www.mbusa.com/en/cpo/search'],
  ['tesla', 'https://www.tesla.com/inventory/used/m3'],
];

const BLOCK = /access denied|are you a human|unusual traffic|verify you are|captcha|just a moment|cf-browser|enable javascript to continue/i;

function carLike(r: Record<string, unknown>): boolean {
  const keys = Object.keys(r).map((k) => k.toLowerCase());
  return keys.some((k) => k.includes('price') || k.includes('bid'))
    && keys.some((k) => k === 'vin' || k.includes('mileage') || k.includes('odometer') || k.includes('year'));
}

async function probe(id: string, url: string): Promise<string> {
  for (const profile of ['chrome', 'firefox133'] as const) {
    try {
      const r = await fetchWithTls(url, {}, { browser: profile } as never);
      const body = r.body ?? '';
      if (r.status !== 200) return `HTTP ${r.status}`;
      if (BLOCK.test(body.slice(0, 5000))) continue;

      const priced = vehicleNodes(extractJsonLd(body)).filter((n) => offerPrice(n) !== null && scalar(n.name));
      if (priced.length >= 3) return `JSON-LD: ${priced.length} priced cars  <- jsonLdMarketplace`;

      let best = { marker: '', n: 0 };
      for (const m of MARKERS) {
        const n = findRecords<Record<string, unknown>>(body, m).filter(carLike).length;
        if (n > best.n) best = { marker: m, n };
      }
      if (best.n >= 3) return `payload: ${best.n} records under "${best.marker}"  <- findRecords`;

      const prices = (body.match(/[$£€¥₹]\s?\d{1,3}[,.]\d{3}/g) ?? []).length;
      return `${Math.round(body.length / 1024)}KB, ${prices} prices in markup, no structured inventory`;
    } catch (e) {
      return `ERR ${(e as Error).message.split('\n')[0].slice(0, 40)}`;
    }
  }
  return 'BLOCKED';
}

/**
 * The TLS client does not hold the event loop open between requests, so a bare
 * `await Promise.all(...)` lets Node decide the program is finished and exit
 * with every probe still pending: an earlier run printed one line out of
 * forty-three and reported "unsettled top-level await". A timer keeps the loop
 * alive until the work is actually done.
 */
const keepAlive = setInterval(() => {}, 1000);
const queue = [...CANDIDATES];
const results: string[] = [];

await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      let verdict: string;
      try {
        verdict = await probe(c[0], c[1]);
      } catch (e) {
        // A worker that throws must not take the other five down with it.
        verdict = `ERR ${(e as Error).message.split('\n')[0].slice(0, 60)}`;
      }
      const line = `${c[0].padEnd(18)} ${verdict}`;
      results.push(line);
      console.log(line);
    }
  }),
);

clearInterval(keepAlive);
console.log(`\n${results.length} of ${CANDIDATES.length} probed`);
