import type { Listing, SourceAdapter } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { isRoundedMileage, parseMake, parseModel, parseYear } from '../core/normalize.js';

const ORIGIN = 'https://www.exoticcartrader.com';

/** The few entities used in titles and URLs on the inventory fragments. */
function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const number = (value: string | undefined): number | null => {
  if (!value) return null;
  const n = Number(value.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

function tokensMatch(a: string | null, b: string): boolean {
  if (!a) return false;
  const tokens = (v: string) => new Set(v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return false;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

/**
 * Parse one HTMX inventory fragment.
 *
 * The site has no JSON payload or schema.org vehicle data. Its stable contract
 * is the server-rendered fragment requested by its own infinite-scroll widget,
 * which is materially safer than selecting Webflow class names in a browser.
 */
export function parseExoticInventory(html: string): Listing[] {
  const now = new Date().toISOString();
  const out = new Map<string, ListingDraft>();

  // Infinite-scroll pages put hx-get before role; initial pages put role first.
  // Attribute order is presentation and cannot decide whether a car exists.
  for (const chunk of html.split(/<div\b[^>]*role="listitem"[^>]*>/i).slice(1)) {
    const href = chunk.match(/href="(\/listing\/[^"?]+)"/i)?.[1];
    const titleRaw = chunk.match(/<h3[^>]*class="[^"]*car-name[^"]*"[^>]*>([\s\S]*?)<\/h3>/i)?.[1];
    const priceRaw = chunk.match(/ASK:\s*\$([\d,.]+)/i)?.[1];
    if (!href || !titleRaw || !priceRaw) continue;

    const title = decodeHtml(titleRaw.replace(/<[^>]+>/g, ''));
    const price = number(priceRaw);
    if (price === null || price <= 0) continue;

    const sourceListingId = href.match(/-(\d+)$/)?.[1] ?? href;
    const id = `exoticcartrader:${sourceListingId}`;
    if (out.has(id)) continue;

    const mileage = number(chunk.match(/Miles:\s*([\d,.]+)/i)?.[1]);
    const imageUrl = chunk.match(/<img[^>]+src="(https:\/\/images\.exoticcartrader\.com\/[^" ]+)"/i)?.[1] ?? null;
    const make = parseMake(title);

    out.set(id, {
      id,
      sourceId: 'exoticcartrader',
      sourceListingId,
      url: `${ORIGIN}${decodeHtml(href)}`,
      title,
      year: parseYear(title),
      make,
      model: parseModel(title, make),
      price,
      priceKind: 'ask',
      currency: 'USD',
      mileage,
      mileageIsRounded: isRoundedMileage(mileage),
      sellerType: 'dealer',
      imageUrl: imageUrl ? decodeHtml(imageUrl) : null,
      firstSeen: now,
      lastSeen: now,
    });
  }

  return [...out.values()].map(makeListing);
}

export const exoticcartrader: SourceAdapter = {
  source: getSource('exoticcartrader')!,

  async search(query, ctx) {
    if (!query.make) {
      ctx.log('exoticcartrader: needs a make, skipping an unbounded catalogue crawl');
      return [];
    }

    const out = new Map<string, Listing>();
    const models = query.models?.length ? query.models : [undefined];

    for (const model of models) {
      let offset = 0;
      for (let page = 0; page < 20; page += 1) {
        const params = new URLSearchParams({ make: query.make, offset: String(offset) });
        if (model) params.set('model', model);
        const url = `${ORIGIN}/htmx/cfs?${params}`;

        try {
          const html = await ctx.fetchText(url, { transport: 'fetch' });
          const rows = parseExoticInventory(html);
          let kept = 0;

          for (const row of rows) {
            if (!row.make || row.make.toLowerCase() !== query.make.toLowerCase()) continue;
            if (model && !tokensMatch(row.model, model)) continue;
            if (query.yearMin !== undefined && (row.year === null || row.year < query.yearMin)) continue;
            if (query.yearMax !== undefined && (row.year === null || row.year > query.yearMax)) continue;
            if (query.priceMin !== undefined && (row.price === null || row.price < query.priceMin)) continue;
            if (query.priceMax !== undefined && (row.price === null || row.price > query.priceMax)) continue;
            if (query.mileageMax !== undefined && (row.mileage === null || row.mileage > query.mileageMax)) continue;
            out.set(row.id, row);
            kept += 1;
          }

          ctx.log(`exoticcartrader ${(model ?? query.make).padEnd(16)} p${page + 1} ${rows.length} listings, ${kept} kept (pool ${out.size})`);
          const next = html.match(/hx-get="\/htmx\/cfs\?[^";]*offset=(\d+)[^";]*"/i)?.[1];
          if (!next || Number(next) <= offset) break;
          offset = Number(next);
        } catch (error) {
          ctx.log(`exoticcartrader ${(model ?? query.make)} FAILED: ${(error as Error).message.split('\n')[0]}`);
          break;
        }
      }
    }

    return [...out.values()];
  },
};
