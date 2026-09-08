import type { Listing, SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { evaluateInPage } from '../transport/browser.js';
import { parseYear, parseMake, parseMileage } from '../core/normalize.js';

/**
 * Cars & Bids, for modern-enthusiast sold prices.
 *
 * Complements Bring a Trailer: BaT skews older and rarer, Cars & Bids covers
 * the 1990s-onward cars most people actually shop for, which makes its sold
 * archive the more useful comparable set for a mainstream buyer.
 */

interface RawRow {
  title: string;
  price: number | null;
  sold: boolean;
  url: string | null;
  mileage: string | null;
  location: string | null;
  image: string | null;
  endsAt: string | null;
}

const EXTRACT = (): RawRow[] => {
  const cards = [...document.querySelectorAll('li.auction-item, div.auction-item, .past-auction')];
  return cards.map((card) => {
    const txt = (sel: string): string => {
      const el = card.querySelector(sel);
      return el ? (el.textContent ?? '').trim() : '';
    };
    const a = card.querySelector('a[href*="/auctions/"]') as HTMLAnchorElement | null;
    const img = card.querySelector('img[src^="http"]') as HTMLImageElement | null;
    const bidText = txt('.bid-value, .high-bid, .value');
    const statusText = (card.textContent ?? '').toLowerCase();
    const m = bidText.replace(/,/g, '').match(/\$?\s*(\d{3,})/);
    return {
      title: txt('.auction-title, h3, .title'),
      price: m && m[1] ? Number(m[1]) : null,
      // "Sold for" marks a completed sale; "bid to" marks a reserve-not-met car,
      // which is a bid and must never enter a comparables median.
      sold: /sold for/.test(statusText),
      url: a ? a.href : null,
      mileage: txt('.mileage, .odometer') || null,
      location: txt('.location') || null,
      image: img ? img.src : null,
      endsAt: card.querySelector('time')?.getAttribute('datetime') ?? null,
    };
  });
};

export const carsandbids: SourceAdapter = {
  source: getSource('carsandbids')!,

  async search(query, ctx) {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    const terms = query.models?.length
      ? query.models.map((m) => `${query.make ?? ''} ${m}`.trim())
      : [query.make ?? query.keywords ?? ''];

    for (const term of terms.filter(Boolean)) {
      const url = `https://carsandbids.com/past-auctions/?q=${encodeURIComponent(term)}`;
      try {
        const rows = await evaluateInPage(url, EXTRACT, {
          waitMs: 4000,
          settleSelector: 'li.auction-item, div.auction-item, .past-auction',
          stableChecks: 2,
          maxPolls: 8,
        });

        for (const r of rows) {
          if (!r.url || !r.title) continue;
          const id = `carsandbids:${r.url}`;
          if (out.has(id)) continue;
          out.set(id, {
            id,
            sourceId: 'carsandbids',
            sourceListingId: r.url.split('/').filter(Boolean).pop() ?? null,
            url: r.url,
            title: r.title,
            year: parseYear(r.title),
            make: parseMake(r.title) ?? query.make ?? null,
            model: null,
            trim: null,
            series: null,
            vin: null,
            price: r.price,
            priceKind: r.sold ? 'sold' : 'bid',
            currency: 'USD',
            mileage: parseMileage(r.mileage),
            mileageIsRounded: false,
            location: r.location,
            sellerType: 'auction',
            bodyType: null,
            exteriorColor: null,
            fuelType: null,
            eventDate: r.endsAt,
            imageUrl: r.image,
            firstSeen: now,
            lastSeen: now,
          });
        }
        ctx.log(`carsandbids ${term.padEnd(20)} +${String(rows.length).padStart(3)} (pool ${out.size})`);
      } catch (e) {
        ctx.log(`carsandbids ${term} FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    return [...out.values()].map(makeListing);
  },
};
