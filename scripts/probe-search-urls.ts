import { fetchWithTls } from '../src/transport/tls.js';
import { extractJsonLd, itemListEntries } from './../src/sources/jsonld.js';

/**
 * Probes candidate SEARCH urls, not homepages.
 *
 * The unwired sweep reads each source's homepage, which answers "is this site
 * reachable" and not "can its inventory be read". A homepage with no cars on it
 * scores zero and looks like a dead end even where the search page ships a full
 * schema.org ItemList. Every source wired through the shared marketplace
 * adapter was found this way, so this asks the question that decides whether a
 * spec is fifteen lines or a bespoke parser.
 */

interface Candidate { id: string; url: string }

const CANDIDATES: Candidate[] = [
  { id: 'carandclassic', url: 'https://www.carandclassic.com/search?listing_type_ex=advert&make=porsche' },
  { id: 'pakwheels', url: 'https://www.pakwheels.com/used-cars/search/-/mk_bmw/' },
  { id: 'classiccars', url: 'https://classiccars.com/listings/find/all-years/porsche' },
  { id: 'jamesedition', url: 'https://www.jamesedition.com/cars/porsche' },
  { id: 'iseecars', url: 'https://www.iseecars.com/cars-for-sale#Make=Porsche' },
  { id: 'carsoup', url: 'https://www.carsoup.com/for-sale/used/porsche/' },
  { id: 'privateauto', url: 'https://privateauto.com/search?make=Porsche' },
  { id: 'autotraderca', url: 'https://www.autotrader.ca/cars/porsche/' },
  { id: 'pistonheads', url: 'https://www.pistonheads.com/buy/search?m=Porsche' },
  { id: 'mercadolibreautos', url: 'https://autos.mercadolibre.com.ar/porsche/' },
  { id: 'otomoto', url: 'https://www.otomoto.pl/osobowe/porsche' },
  { id: 'lacentrale', url: 'https://www.lacentrale.fr/listing?makesModelsCommercialNames=PORSCHE' },
  { id: 'cochesnet', url: 'https://www.coches.net/porsche-ocasion/' },
  { id: 'marktplaats', url: 'https://www.marktplaats.nl/l/auto-s/porsche/' },
  { id: 'subito', url: 'https://www.subito.it/annunci-italia/vendita/auto/?q=porsche' },
  { id: 'mobilebg', url: 'https://www.mobile.bg/obiavi/avtomobili-dzhipove/porsche' },
  { id: 'trademe', url: 'https://www.trademe.co.nz/a/motors/cars/porsche' },
  { id: 'autotraderza', url: 'https://www.autotrader.co.za/cars-for-sale/porsche' },
  { id: 'goonet', url: 'https://www.goo-net.com/usedcar/brand-PORSCHE/' },
  { id: 'carsensor', url: 'https://www.carsensor.net/usedcar/bPO/index.html' },
  { id: 'webmotors', url: 'https://www.webmotors.com.br/carros/estoque/porsche' },
  { id: 'cars24', url: 'https://www.cars24.com/buy-used-bmw-cars/' },
  { id: 'poctra', url: 'https://poctra.com/search?q=porsche' },
  { id: 'classicdriver', url: 'https://www.classicdriver.com/en/cars/search?make=porsche' },
  { id: 'exoticcartrader', url: 'https://www.exoticcartrader.com/inventory?make=Porsche' },
  { id: 'caredge', url: 'https://caredge.com/porsche/inventory' },
  { id: 'driveway', url: 'https://www.driveway.com/shop?make=porsche' },
  { id: 'offerup', url: 'https://offerup.com/search?q=porsche&cid=6' },
  { id: 'searchtempest', url: 'https://www.searchtempest.com/results?category=cta&makeModel=porsche' },
  { id: 'hertzcarsales', url: 'https://www.hertzcarsales.com/used-vehicles/' },
  { id: 'enterprisecarsales', url: 'https://www.enterprisecarsales.com/list/used-cars' },
  { id: 'municibid', url: 'https://municibid.com/browse/vehicles' },
  { id: 'publicsurplus', url: 'https://www.publicsurplus.com/sms/browse/cataucs?catid=4' },
  { id: 'barrettjackson', url: 'https://www.barrett-jackson.com/Events/Event/Search?searchTerm=porsche' },
  { id: 'collectingcars', url: 'https://collectingcars.com/buy/porsche' },
  { id: 'goodingco', url: 'https://www.goodingco.com/vehicles' },
  { id: 'rmsothebys', url: 'https://rmsothebys.com/search?q=porsche' },
];

const PROFILES = ['chrome', 'firefox133'] as const;
const BLOCK = /access denied|are you a human|unusual traffic|verify you are|captcha|just a moment|cf-browser/i;

async function probe(c: Candidate) {
  for (const profile of PROFILES) {
    try {
      const r = await fetchWithTls(c.url, {}, { browser: profile } as never);
      const body = r.body ?? '';
      if (r.status !== 200 || BLOCK.test(body.slice(0, 4000))) continue;
      const nodes = extractJsonLd(body);
      const cars = itemListEntries(nodes);
      const payload = (body.match(/__NEXT_DATA__|__remixContext|self\.__next_f|__NUXT__|__INITIAL_STATE__/g) ?? []).length;
      const prices = (body.match(/[$£€¥₹]\s?\d{1,3}[,.]\d{3}/g) ?? []).length;
      return { profile, status: r.status, bytes: body.length, nodes: nodes.length, cars: cars.length, payload, prices };
    } catch { /* try the next profile */ }
  }
  return null;
}

const queue = [...CANDIDATES];
console.log('source                 profile      bytes  ldNodes  ldCars payload prices  verdict');
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      const v = await probe(c);
      if (!v) {
        console.log(`${c.id.padEnd(22)} ${'-'.padEnd(11)} ${'-'.padStart(9)} ${'-'.padStart(8)} ${'-'.padStart(7)} ${'-'.padStart(7)} ${'-'.padStart(6)}  BLOCKED`);
        continue;
      }
      const verdict = v.cars > 2 ? 'WIRE IT: json-ld ItemList' : v.payload > 0 ? 'embedded payload' : v.prices > 5 ? 'html only' : 'nothing found';
      console.log(
        `${c.id.padEnd(22)} ${v.profile.padEnd(11)} ${String(v.bytes).padStart(9)} ${String(v.nodes).padStart(8)} ` +
        `${String(v.cars).padStart(7)} ${String(v.payload).padStart(7)} ${String(v.prices).padStart(6)}  ${verdict}`,
      );
    }
  }),
);
