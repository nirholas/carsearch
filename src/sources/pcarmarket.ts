import type { SourceAdapter, PriceKind } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { findRecords } from './nextjs.js';
import { parseYear, parseMake, parseModel } from '../core/normalize.js';
import { mileageFromText } from '../enrich/text-facets.js';

/**
 * PCARMARKET: Porsche-focused enthusiast auctions.
 *
 * Reachable only with a browser TLS fingerprint, and the listings ride in the
 * page payload rather than in an XHR, which is why an endpoint hunt found
 * nothing and the first URL tried (/auction/) turned out to be their blog.
 *
 * Two pages, two kinds of number. /auctions/ carries live lots, every one of
 * them status "Active", whose high bid is not a price anyone has paid.
 * /results/ carries finished ones, and a lot that both ended and met its
 * reserve did sell. The check is deliberately conservative: an ended lot whose
 * reserve went unmet is still recorded as a bid, because no sale happened.
 *
 * Getting that wrong in the generous direction is the single error this whole
 * index is built to avoid, and it would be invisible afterwards: a bid filed as
 * a sale simply looks like a cheap sale.
 */

interface PcarVehicle {
  make?: string;
  model?: string;
  year?: number;
  slug_model?: string;
}

interface PcarLot {
  id?: number;
  title?: string;
  slug?: string;
  vehicle?: PcarVehicle;
  status?: string;
  auction_type?: number;
  reserve_status?: string;
  reserve_price?: number | null;
  /** A formatted string; `high_bid` is the number. */
  current_bid?: string;
  high_bid?: number;
  bid_count?: number;
  /** Odometer reading, with its unit in `odometer_type`. */
  mileage_body?: number;
  odometer_type?: string;
  start_date?: string;
  end_date?: string;
  featured_image_large_url?: string;
  featured_image_url?: string;
  has_warranty?: boolean;
}

const PAGES = ['https://www.pcarmarket.com/auctions/', 'https://www.pcarmarket.com/results/'];

/** Their odometer carries its own unit, so a kilometre reading is converted. */
function miles(lot: PcarLot): number | null {
  const n = lot.mileage_body;
  if (typeof n !== 'number' || n <= 0) return null;
  return /km/i.test(lot.odometer_type ?? '') ? Math.round(n * 0.621371) : n;
}

/** A lot that ended AND met its reserve sold. Anything else is still a bid. */
function priceOf(lot: PcarLot): { price: number | null; kind: PriceKind } {
  const bid = typeof lot.high_bid === 'number' && lot.high_bid > 0 ? lot.high_bid : null;
  const ended = /sold|ended|closed|complete/i.test(lot.status ?? '');
  return { price: bid, kind: ended && lot.reserve_status === 'met' ? 'sold' : 'bid' };
}

export const pcarmarket: SourceAdapter = {
  source: getSource('pcarmarket')!,

  async search(query, ctx) {
    const out = new Map<string, ListingDraft>();

    for (const url of PAGES) {
      try {
        const res = await fetchWithTls(url);
        if (res.status !== 200) {
          ctx.log(`pcarmarket ${url.slice(28)} HTTP ${res.status}`);
          continue;
        }

        const lots = findRecords<PcarLot>(res.body, 'id').filter((l) => 'current_bid' in l && l.id);
        let kept = 0;

        for (const lot of lots) {
          const id = `pcarmarket:${lot.id}`;
          if (out.has(id)) continue;

          const { price, kind } = priceOf(lot);
          if (price === null || !lot.title) continue;

          const make = lot.vehicle?.make ?? parseMake(lot.title);
          out.set(id, {
            id,
            sourceId: 'pcarmarket',
            sourceListingId: String(lot.id),
            url: lot.slug ? `https://www.pcarmarket.com/auction/${lot.slug}/` : null,
            title: lot.title,
            year: lot.vehicle?.year ?? parseYear(lot.title),
            make,
            model: lot.vehicle?.model ?? parseModel(lot.title, make),
            price,
            priceKind: kind,
            currency: 'USD',
            // Their titles state mileage too ("44k-Mile"); the field is exact.
            mileage: miles(lot) ?? mileageFromText(lot.title),
            mileageIsRounded: miles(lot) === null,
            sellerType: 'auction',
            eventDate: lot.end_date ? lot.end_date.slice(0, 10) : null,
            imageUrl: lot.featured_image_large_url ?? lot.featured_image_url ?? null,
            raw: {
              status: lot.status,
              reserveStatus: lot.reserve_status,
              bidCount: lot.bid_count,
              hasWarranty: lot.has_warranty,
            },
          });
          kept += 1;
        }
        ctx.log(`pcarmarket ${url.slice(28).padEnd(12)} ${String(lots.length).padStart(3)} lots, ${kept} kept (pool ${out.size})`);
      } catch (e) {
        ctx.log(`pcarmarket ${url.slice(28)} FAILED: ${(e as Error).message.split('\n')[0]}`);
      }
    }

    /**
     * Their pages are not filterable by make from the URL, so the whole current
     * catalogue is collected and narrowed here. It is a couple of dozen lots.
     */
    const wanted = query.make?.toLowerCase();
    const rows = [...out.values()].filter(
      (l) => !wanted || (l.make ?? '').toLowerCase().includes(wanted) || (l.title ?? '').toLowerCase().includes(wanted),
    );
    if (wanted && rows.length !== out.size) {
      ctx.log(`pcarmarket filtered ${out.size} lots to ${rows.length} matching "${query.make}"`);
    }
    return rows.map(makeListing);
  },
};
