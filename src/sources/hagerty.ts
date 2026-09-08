import type { SourceAdapter, PriceKind } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { findRecords } from './nextjs.js';
import { parseYear, parseMake, parseModel } from '../core/normalize.js';

/**
 * Hagerty Marketplace: collector-car auctions from the insurer that values them.
 *
 * Worth wiring for the same reason Bring a Trailer is: it produces completed
 * sales, which is the scarcest input this index has and the one every statistic
 * on the market dashboard rests on.
 *
 * Their money fields are in CENTS. A 1963 356B carrying `amount: 12500000` is
 * $125,000, not $12.5 million, and reading it as dollars would put a fictional
 * eight-figure car into the collector cohort and wreck every median it touched.
 * This is exactly the class of error that looks like data rather than a bug.
 */

interface MonetaryValue {
  amount?: number;
  currency?: string;
}

interface HagertyLot {
  id?: string;
  year?: string | number;
  make?: string;
  model?: string;
  lotTitle?: string;
  auctionTitle?: string;
  shortDescription?: string;
  mileage?: { mileage?: number; mileageUnit?: string };
  currentHighestBid?: MonetaryValue;
  soldPrice?: MonetaryValue;
  hasBeenSold?: boolean | null;
  hasBeenSoldAfter?: boolean | null;
  hasReserve?: boolean | null;
  status?: string;
  endDateTime?: string;
  successfulBidCount?: number;
  isDealer?: boolean | null;
  auctionLocation?: { city?: string; state?: string };
  auctionPhoto?: { id?: string; url?: string };
  featuredPhotos?: { url?: string }[];
}

const PAGES = [
  'https://www.hagerty.com/marketplace',
  'https://www.hagerty.com/marketplace/auctions/results',
];

/** Their amounts are integer cents. Dividing is not optional. */
function dollars(v: MonetaryValue | undefined): number | null {
  const cents = v?.amount;
  if (typeof cents !== 'number' || cents <= 0) return null;
  return Math.round(cents / 100);
}

/** Miles, converting the kilometre readings their international lots carry. */
function miles(m: HagertyLot['mileage']): number | null {
  const n = m?.mileage;
  if (typeof n !== 'number' || n <= 0) return null;
  return /km|kilomet/i.test(m?.mileageUnit ?? '') ? Math.round(n * 0.621371) : n;
}

/**
 * A live lot has a bid; a finished one has a price someone paid. Recording a
 * live bid as a sale is the single error this whole index is built to avoid.
 */
function priceOf(lot: HagertyLot): { price: number | null; kind: PriceKind } {
  const sold = dollars(lot.soldPrice);
  const ended = lot.hasBeenSold === true || lot.hasBeenSoldAfter === true || /sold|ended|closed|complete/i.test(lot.status ?? '');
  if (ended) {
    // A finished lot whose price is withheld is not a sale we can record.
    const price = sold ?? dollars(lot.currentHighestBid);
    return { price, kind: 'sold' };
  }
  return { price: dollars(lot.currentHighestBid), kind: 'bid' };
}

export const hagertymarketplace: SourceAdapter = {
  source: getSource('hagertymarketplace')!,

  async search(query, ctx) {
    const out = new Map<string, ListingDraft>();

    for (const url of PAGES) {
      try {
        const res = await fetchWithTls(url);
        if (res.status !== 200) {
          ctx.log(`hagerty ${url.slice(30)} HTTP ${res.status}`);
          continue;
        }

        const lots = findRecords<HagertyLot>(res.body, 'mileage').filter((l) => l.id);
        let kept = 0;

        for (const lot of lots) {
          const id = `hagertymarketplace:${lot.id}`;
          if (out.has(id)) continue;

          const { price, kind } = priceOf(lot);
          if (price === null) continue;

          const title = lot.lotTitle ?? lot.auctionTitle ?? [lot.year, lot.make, lot.model].filter(Boolean).join(' ');
          if (!title) continue;

          const make = lot.make ?? parseMake(title);
          const year = Number(lot.year);
          const place = lot.auctionLocation;

          out.set(id, {
            id,
            sourceId: 'hagertymarketplace',
            sourceListingId: lot.id ?? null,
            url: `https://www.hagerty.com/marketplace/auctions/${lot.id}`,
            title,
            year: Number.isFinite(year) && year > 1800 ? year : parseYear(title),
            make,
            model: lot.model ?? parseModel(title, make),
            price,
            priceKind: kind,
            currency: lot.currentHighestBid?.currency ?? 'USD',
            mileage: miles(lot.mileage),
            mileageIsRounded: false,
            location: place?.city ? [place.city.trim(), place.state].filter(Boolean).join(', ') : null,
            sellerType: 'auction',
            eventDate: lot.endDateTime ? lot.endDateTime.slice(0, 10) : null,
            imageUrl: lot.featuredPhotos?.[0]?.url ?? lot.auctionPhoto?.url ?? null,
            raw: {
              status: lot.status,
              hasReserve: lot.hasReserve,
              bidCount: lot.successfulBidCount,
              soldAfterAuction: lot.hasBeenSoldAfter,
              isDealer: lot.isDealer,
            },
          });
          kept += 1;
        }
        ctx.log(`hagerty ${url.slice(30).padEnd(28)} ${String(lots.length).padStart(3)} lots, ${kept} kept (pool ${out.size})`);
      } catch (e) {
        ctx.log(`hagerty ${url.slice(30)} FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    /**
     * Their marketplace page is not searchable by make from the URL, so the
     * whole current catalogue is collected and filtered here. It is a few
     * hundred lots, not a few hundred thousand.
     */
    const wanted = query.make?.toLowerCase();
    const rows = [...out.values()].filter(
      (l) => !wanted || (l.make ?? '').toLowerCase().includes(wanted) || (l.title ?? '').toLowerCase().includes(wanted),
    );
    if (wanted && rows.length !== out.size) {
      ctx.log(`hagerty filtered ${out.size} lots to ${rows.length} matching "${query.make}"`);
    }
    return rows.map(makeListing);
  },
};
