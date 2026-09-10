import { fetchWithTls } from '../src/transport/tls.js';
import { nextFlightText, findRecords } from '../src/sources/nextjs.js';

/**
 * Finds the field name that identifies inventory inside an embedded payload.
 *
 * A React Flight or __NEXT_DATA__ payload is megabytes of config, analytics and
 * routing objects with the cars somewhere inside it, and the readers in
 * nextjs.ts need to be told which field marks a record. Guessing that field by
 * reading minified JavaScript is the slowest part of wiring one of these
 * sources; this tries the obvious candidates and reports which one yields
 * objects that look like cars.
 */

const MARKERS = [
  'vin', 'mileage', 'odometer', 'listingId', 'stockNumber', 'askingPrice',
  'price', 'salePrice', 'currentBid', 'modelYear', 'year', 'makeName', 'make',
];

const CANDIDATES: [string, string][] = [
  ['collectingcars', 'https://collectingcars.com/buy/porsche'],
  ['pistonheads', 'https://www.pistonheads.com/buy/search?m=Porsche'],
  ['caredge', 'https://caredge.com/porsche/inventory'],
  ['cars24', 'https://www.cars24.com/buy-used-bmw-cars/'],
  ['otomoto', 'https://www.otomoto.pl/osobowe/porsche'],
  ['marktplaats', 'https://www.marktplaats.nl/l/auto-s/porsche/'],
  ['subito', 'https://www.subito.it/annunci-italia/vendita/auto/?q=porsche'],
  ['webmotors', 'https://www.webmotors.com.br/carros/estoque/porsche'],
  ['lacentrale', 'https://www.lacentrale.fr/listing?makesModelsCommercialNames=PORSCHE'],
  ['cochesnet', 'https://www.coches.net/porsche-ocasion/'],
  ['driveway', 'https://www.driveway.com/shop?make=porsche'],
  ['iseecars', 'https://www.iseecars.com/used-cars-for-sale'],
  ['municibid', 'https://municibid.com/browse/vehicles'],
];

/** A record is car-shaped when it carries a price and something identifying. */
function carLike(r: Record<string, unknown>): boolean {
  const keys = Object.keys(r).map((k) => k.toLowerCase());
  const hasPrice = keys.some((k) => k.includes('price') || k.includes('bid'));
  const hasId = keys.some((k) => k === 'vin' || k.includes('mileage') || k.includes('odometer') || k.includes('year'));
  return hasPrice && hasId;
}

const queue = [...CANDIDATES];
await Promise.all(
  Array.from({ length: 5 }, async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const [id, url] = c;
      try {
        const r = await fetchWithTls(url);
        const body = r.body ?? '';
        if (r.status !== 200) { console.log(`${id.padEnd(18)} HTTP ${r.status}`); continue; }
        const flight = nextFlightText(body);
        const hits: string[] = [];
        for (const m of MARKERS) {
          const recs = findRecords<Record<string, unknown>>(body, m);
          const cars = recs.filter(carLike);
          if (cars.length >= 3) hits.push(`${m}=${cars.length}`);
        }
        const shape = flight ? `flight ${Math.round(flight.length / 1024)}KB` : 'no flight payload';
        console.log(`${id.padEnd(18)} ${String(body.length).padStart(8)}b ${shape.padEnd(20)} ${hits.length ? hits.join(' ') : 'no car-shaped records under any marker'}`);
        const best = MARKERS.map((m) => [m, findRecords<Record<string, unknown>>(body, m).filter(carLike)] as const)
          .sort((a, b) => b[1].length - a[1].length)[0];
        if (best && best[1].length >= 3) {
          console.log(`   sample keys: ${Object.keys(best[1][0]!).slice(0, 18).join(',')}`);
        }
      } catch (e) {
        console.log(`${id.padEnd(18)} ERR ${(e as Error).message.split('\n')[0].slice(0, 60)}`);
      }
    }
  }),
);
