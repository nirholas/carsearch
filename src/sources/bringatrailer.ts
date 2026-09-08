import type { Listing, SearchQuery, SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { evaluateInPage } from '../transport/browser.js';
import { parseYear, parseMake } from '../core/normalize.js';

/**
 * Bring a Trailer, for completed sale prices.
 *
 * This is the differentiator. Every incumbent aggregator shows asking prices.
 * Asks are what a seller hopes for; sold prices are what the market paid, and
 * the gap between them is the single most useful number a buyer can be shown.
 *
 * Three structural traps live in this extractor, each of which silently
 * returned zero or wrong records before it was handled:
 *
 * 1. Sold and live cards share a class but not a shape. On a sold card the
 *    `.listing-card` IS the anchor and the title lives in an `h3`. On a live
 *    card the anchor is nested and carries a `title` attribute.
 * 2. `.item-results` holds the sold price but is not rendered, so `innerText`
 *    returns an empty string and only `textContent` reaches it.
 * 3. Prices must be read from inside the card. Pairing by page-wide regex gave
 *    every car in a model line the same price, recording a 2019 i8 Roadster as
 *    selling for $2,700.
 */

interface RawSale {
  title: string;
  price: number;
  date: string;
  url: string;
  image: string | null;
}

const EXTRACT = (): RawSale[] =>
  [...document.querySelectorAll('.listing-card')]
    .map((card) => {
      const res = card.querySelector('.item-results');
      if (!res) return null;
      // textContent, not innerText: this node is in the DOM but not rendered.
      const m = (res.textContent ?? '').match(/Sold for USD \$([\d,]+)\s+on\s+(\d+\/\d+\/\d+)/);
      if (!m || !m[1] || !m[2]) return null; // live auction, or bid without a sale
      const h3 = card.querySelector('h3');
      const title = (h3 ? (h3.textContent ?? '') : '').trim();
      const href =
        card.tagName === 'A'
          ? card.getAttribute('href')
          : (card.querySelector('a[href*="/listing/"]') as HTMLAnchorElement | null)?.href;
      if (!title || !href) return null;
      const img = card.querySelector('img[src^="http"]') as HTMLImageElement | null;
      return {
        title,
        price: Number(m[1].replace(/,/g, '')),
        date: m[2],
        url: String(href).split('?')[0] ?? '',
        image: img ? img.src : null,
      };
    })
    .filter((x): x is RawSale => x !== null);

/** BaT organizes by make/model path rather than by query string. */
function paths(query: SearchQuery): string[] {
  const make = (query.make ?? '').toLowerCase().replace(/\s+/g, '-');
  if (!make) return [];
  if (!query.models?.length) return [make];
  return query.models.map((m) => `${make}/${m.toLowerCase().replace(/\s+/g, '-')}`);
}

/** "09/04/2026" to an ISO date, so every source stores dates the same way. */
function toIso(usDate: string): string | null {
  const [mm, dd, yyyy] = usDate.split('/');
  if (!mm || !dd || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

export const bringatrailer: SourceAdapter = {
  source: getSource('bringatrailer')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();

    for (const path of paths(query)) {
      const url = `https://bringatrailer.com/${path}/`;
      try {
        const rows = await evaluateInPage(url, EXTRACT, {
          waitMs: 3500,
          // BaT pages results behind a "Show More" control rather than infinite scroll.
          expandSelector: 'button:has-text("Show More"), a:has-text("Show More")',
          maxExpands: 8,
        });

        for (const r of rows) {
          const id = `bringatrailer:${r.url}`;
          if (out.has(id)) continue;
          out.set(id, {
            id,
            sourceId: 'bringatrailer',
            sourceListingId: r.url.split('/').filter(Boolean).pop() ?? null,
            url: r.url,
            title: r.title,
            year: parseYear(r.title),
            make: parseMake(r.title) ?? query.make ?? null,
            model: path.split('/')[1] ?? null,
            trim: null,
            series: null,
            vin: null,
            price: r.price,
            // The whole point of this adapter.
            priceKind: 'sold',
            currency: 'USD',
            mileage: null,
            mileageIsRounded: false,
            location: null,
            sellerType: 'auction',
            bodyType: null,
            exteriorColor: null,
            fuelType: null,
            eventDate: toIso(r.date),
            imageUrl: r.image,
            firstSeen: now,
            lastSeen: now,
          });
        }

        const distinct = new Set(rows.map((r) => r.price)).size;
        const suspect = distinct <= 1 && rows.length > 1 ? '  <-- SUSPECT, check the extractor' : '';
        ctx.log(`bringatrailer ${path.padEnd(20)} ${String(rows.length).padStart(3)} sold, ${distinct} distinct prices${suspect}`);
      } catch (e) {
        ctx.log(`bringatrailer ${path} FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    return [...out.values()].map(makeListing);
  },
};
