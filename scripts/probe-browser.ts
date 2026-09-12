import { evaluateInPage, closeBrowser } from '../src/transport/browser.js';

/**
 * Re-probes candidates that refuse a TLS fetch, using a real browser.
 *
 * A 403 to `fetchWithTls` is not a verdict on a source, it is a verdict on one
 * transport. Several of the largest marketplaces in the world answer 403 to
 * every TLS fingerprint and 200 to Chromium, which is exactly why `browser` is
 * its own transport in the registry rather than a flavour of fetch. Reading a
 * TLS sweep as "these sites are blocked" writes off real inventory.
 *
 * Runs in the page so it sees the DOM after hydration, and reports which of the
 * three readers would wire the source.
 */

const CANDIDATES: [string, string][] = [
  ['edmunds', 'https://www.edmunds.com/inventory/srp.html?make=porsche'],
  ['autolist', 'https://www.autolist.com/porsche'],
  ['autonation', 'https://www.autonation.com/cars/porsche'],
  ['echopark', 'https://www.echopark.com/inventory?make=Porsche'],
  ['carsalesau', 'https://www.carsales.com.au/cars/porsche/'],
  ['mobilede', 'https://suchen.mobile.de/fahrzeuge/search.html?makeModelVariant1.makeId=20100'],
  ['lacentrale', 'https://www.lacentrale.fr/listing?makesModelsCommercialNames=PORSCHE'],
  ['leboncoin', 'https://www.leboncoin.fr/recherche?category=2&text=porsche'],
  ['sgcarmart', 'https://www.sgcarmart.com/used-cars/listing?brand=porsche'],
  ['webmotors', 'https://www.webmotors.com.br/carros/estoque/porsche'],
  ['kavak', 'https://www.kavak.com/mx/autos-seminuevos-y-usados-porsche'],
  ['autotraderuk', 'https://www.autotrader.co.uk/car-search?make=PORSCHE'],
  ['classicdriver', 'https://www.classicdriver.com/en/cars/porsche'],
  ['bonhamscars', 'https://cars.bonhams.com/en/search?q=porsche'],
  ['tesla', 'https://www.tesla.com/inventory/used/m3'],
  ['carsforsale', 'https://www.carsforsale.com/used-porsche-for-sale'],
];

/** Runs in the page. Reports what a reader would find, without shipping the page back. */
const EXTRACT = () => {
  const out = { ld: 0, ldCars: 0, payloadKeys: [] as string[], prices: 0, bytes: document.documentElement.outerHTML.length };

  for (const s of [...document.querySelectorAll('script[type="application/ld+json"]')]) {
    out.ld += 1;
    try {
      const text = JSON.stringify(JSON.parse(s.textContent ?? 'null'));
      out.ldCars += (text.match(/"@type"\s*:\s*"(Car|Vehicle|Product)"/gi) ?? []).length;
    } catch { /* a malformed block is not a car */ }
  }

  // The globals a framework parks its server data in.
  for (const key of ['__NEXT_DATA__', '__NUXT__', '__INITIAL_STATE__', '__remixContext', '__APOLLO_STATE__', '__PRELOADED_STATE__']) {
    if ((window as unknown as Record<string, unknown>)[key]) out.payloadKeys.push(key);
  }
  if (document.documentElement.outerHTML.includes('self.__next_f')) out.payloadKeys.push('next-flight');

  out.prices = (document.body.innerText.match(/[$£€¥₹R]\s?\d{1,3}[,. ]\d{3}/g) ?? []).length;
  return out;
};

/**
 * A browser probe is slow and some of these hosts challenge hard, so progress
 * is printed before each attempt: a sweep that dies silently on candidate two
 * is indistinguishable from one where the remaining sites all failed.
 */
for (const [id, url] of CANDIDATES) {
  process.stdout.write(`${id.padEnd(14)} ... `);
  try {
    const r = await evaluateInPage(url, EXTRACT, { waitMs: 6000 });
    const verdict = r.ldCars >= 3 ? `JSON-LD: ${r.ldCars} cars  <- jsonLdMarketplace`
      : r.payloadKeys.length ? `payload: ${r.payloadKeys.join('+')}, ${r.prices} prices`
      : r.prices > 8 ? `markup only: ${r.prices} prices`
      : 'nothing found';
    console.log(`${String(Math.round(r.bytes / 1024)).padStart(5)}KB  ld=${r.ld} ldCars=${r.ldCars}  ${verdict}`);
  } catch (e) {
    console.log(`FAILED: ${(e as Error).message.split('\n')[0].slice(0, 70)}`);
  }
}

await closeBrowser();
