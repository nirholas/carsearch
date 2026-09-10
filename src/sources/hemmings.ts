import type { Listing, SearchQuery, SourceAdapter, AdapterContext } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { parseYear, parseMake, parseModel, isRoundedMileage } from '../core/normalize.js';

/**
 * Hemmings.
 *
 * Recorded blocked to all three transports until 2026-09-09, and it never was.
 * The earlier test tried the bare `chrome` and `firefox` aliases, read two 403s
 * as a wall, and stopped. `firefox133` answers 200 with 697KB: the alias points
 * at a build old enough to be fingerprinted while a pinned recent one is not.
 *
 * It rate limits hard, and that is the whole difficulty of this source rather
 * than an aside. Measured over a timed sequence: two requests twenty seconds
 * apart both returned a full page, the third returned a Cloudflare interstitial,
 * and about ninety seconds of quiet cleared it. So this adapter paces itself in
 * tens of seconds and treats the interstitial as throttling to back off from,
 * never as a block to give up on.
 *
 * There is no payload to lift. The only JSON-LD on the page is Organization,
 * WebSite and BreadcrumbList, with nothing about the cars, so the listings are
 * read from markup. Per the trap that cost this project four extractors, the
 * pairing is anchored: the page is split into cards on the image anchor and each
 * field is read from inside one card, never by scanning the document for the
 * next match. A page-wide price regex here would give every car in a row the
 * same price.
 */

/** Two requests then a challenge, cleared by ~90s. Pace well inside that. */
const GAP_MS = 25_000;
const CHALLENGE = /Just a moment|cf-browser-verification|challenge-platform/i;

/**
 * Each card begins at its image link, the only anchor carrying this class.
 *
 * Two things about the markup that a tidier-looking pattern gets wrong. The
 * attributes are split across lines, so the match has to tolerate whitespace
 * rather than assume `<a href=`. And the path is `/auction/` for a lot and
 * `/listing/` for a classified, so keying on one silently drops half the page.
 */
const CARD_SPLIT = /<a\s+href="\/(?:listing|auction)\/[^"]+"[\s\S]{0,200}?class="block relative/;

class Challenged extends Error {}

async function page(url: string, ctx: AdapterContext): Promise<string> {
  const r = await fetchWithTls(url, {}, { browser: 'firefox133' } as never);
  if (r.status !== 200 || CHALLENGE.test(r.body.slice(0, 3000))) {
    ctx.log(`hemmings: challenged on ${url} (HTTP ${r.status})`);
    throw new Challenged('challenged');
  }
  return r.body;
}

/**
 * `1988-porsche-911-ottowa-ontario-334432` carries the year, the marque, the
 * model, where the car is and Hemmings' own id, which is the only stable
 * identifier on the page.
 */
export function parseSlug(
  slug: string,
  make?: string | null,
  model?: string | null,
): { id: string | null; location: string | null } {
  const m = slug.match(/^(.*)-(\d{5,})$/);
  if (!m) return { id: null, location: null };
  let parts = (m[1] ?? '').split('-').filter(Boolean);

  /**
   * The place is whatever is left once the car is removed.
   *
   * Counting segments from the end cannot work: `sarasota-fl` is one word and
   * `los-angeles-ca` is two, and a fixed slice either cuts "Los Angeles" down
   * to "Angeles" or drags the model into the city, which is how
   * `1975-porsche-914-sarasota-fl` first rendered as "914 Sarasota, FL".
   * Nothing in the slug marks the boundary. But the caller has already read the
   * year, make and model off the title, so those are stripped by name rather
   * than guessed at by position, and the remainder is the place.
   */
  const strip = (value: string | null | undefined) => {
    for (const token of (value ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      if (parts[0] === token) parts = parts.slice(1);
    }
  };
  if (/^(19|20)\d{2}$/.test(parts[0] ?? '')) parts = parts.slice(1);
  strip(make);
  strip(model);
  if (parts.length === 0) return { id: m[2]!, location: null };

  const title = (w: string) => w.replace(/\b\w/g, (c) => c.toUpperCase());
  const last = parts[parts.length - 1] ?? '';
  const location = /^[a-z]{2}$/.test(last) && parts.length > 1
    ? `${parts.slice(0, -1).map(title).join(' ')}, ${last.toUpperCase()}`
    : parts.map(title).join(' ');
  return { id: m[2]!, location: location || null };
}


const textOf = (html: string): string =>
  html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

/** Reads one card. Returns null when the card carries no usable price. */
export function parseCard(card: string, now: string): ListingDraft | null {
  const href = card.match(/href="\/(listing|auction)\/([^"]+)"/);
  const kind = href?.[1];
  const slug = href?.[2];
  if (!slug || !kind) return null;

  const h3 = card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
  const title = h3 ? textOf(h3[1]!) : '';
  if (!title) return null;

  /**
   * The price label decides the KIND, and mixing the two would put live bids
   * into the same population as asking prices. A lot mid-auction is legitimately
   * far below market until it closes.
   */
  const asking = /ASKING PRICE[\s\S]{0,400}?\$([\d,]+)/.exec(card);
  const bidding = /CURRENT BID[\s\S]{0,400}?\$([\d,]+)/.exec(card);
  const raw = asking?.[1] ?? bidding?.[1];
  if (!raw) return null;
  const price = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(price) || price <= 0) return null;

  const year = parseYear(title);
  const make = parseMake(title);
  const model = parseModel(title, make);

  const { id, location: fromSlug } = parseSlug(slug, make, model);
  if (!id) return null;
  // The card usually states the place outright ("Lockport, NY USA"), which
  // beats reconstructing it from a URL.
  const stated = /\b([A-Z][A-Za-z.' -]{1,28}),\s*([A-Z]{2})\b/.exec(textOf(card));
  const location = stated ? `${stated[1]!.trim()}, ${stated[2]}` : fromSlug;

  const img = card.match(/<img[^>]+src="(https:\/\/[^"]+)"/)?.[1] ?? null;
  const mileage = Number(/([\d,]+)\s*(?:mi|miles)\b/i.exec(textOf(card))?.[1]?.replace(/,/g, '') ?? '');

  return {
    id: `hemmings:${id}`,
    sourceId: 'hemmings',
    sourceListingId: id,
    url: `https://www.hemmings.com/${kind}/${slug}`,
    title,
    year,
    make,
    model,
    price,
    priceKind: asking ? 'ask' : 'bid',
    currency: 'USD',
    mileage: Number.isFinite(mileage) && mileage > 0 ? mileage : null,
    mileageIsRounded: Number.isFinite(mileage) ? isRoundedMileage(mileage) : false,
    location,
    imageUrl: img,
    firstSeen: now,
    lastSeen: now,
    raw: { hemmingsSlug: slug, hemmingsKind: kind },
  };
}

export function parseCards(html: string, now: string): ListingDraft[] {
  /**
   * Sliced between card starts, never split on them.
   *
   * `split` discards the delimiter, which throws away the very anchor that
   * carries the listing's href and id. On the live page that went unnoticed,
   * because a classified repeats its href on the title link a few lines later,
   * so the chunk still had one to find. An auction card does not, and would
   * have been dropped in silence for as long as the source stayed wired.
   */
  const starts = [...html.matchAll(new RegExp(CARD_SPLIT.source, 'g'))].map((m) => m.index!);
  const out: ListingDraft[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < starts.length; i++) {
    const card = html.slice(starts[i]!, starts[i + 1] ?? html.length);
    const d = parseCard(card, now);
    if (d && !seen.has(d.id)) {
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const hemmings: SourceAdapter = {
  source: getSource('hemmings')!,

  async search(query: SearchQuery, ctx: AdapterContext): Promise<Listing[]> {
    if (!query.make) {
      ctx.log('hemmings: needs a make, skipping');
      return [];
    }
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    const targets = query.models?.length ? query.models : [undefined];

    for (const model of targets) {
      const path = [slugify(query.make), model ? slugify(model) : ''].filter(Boolean).join('/');
      // Three pages at most. The rate limit makes depth expensive, and the
      // first pages are the ones a buyer sees.
      for (let p = 1; p <= 3; p++) {
        const url = `https://www.hemmings.com/classifieds/cars-for-sale/${path}${p > 1 ? `?page=${p}` : ''}`;
        let html: string;
        try {
          html = await page(url, ctx);
        } catch (e) {
          if (e instanceof Challenged) {
            ctx.log('hemmings: backing off, the rest of this make is skipped rather than hammered');
            break;
          }
          ctx.log(`hemmings ${model ?? 'all'} p${p} FAILED: ${(e as Error).message.split('\n')[0]}`);
          break;
        }

        const cards = parseCards(html, now);
        let added = 0;
        for (const d of cards) {
          // Trust the card's own make, never the URL: an unrecognised slug on
          // these sites answers 200 with unrelated cars.
          if (d.make && d.make.toLowerCase().replace(/[^a-z0-9]/g, '') !== query.make.toLowerCase().replace(/[^a-z0-9]/g, '')) continue;
          if (out.has(d.id)) continue;
          out.set(d.id, d);
          added++;
        }
        ctx.log(`hemmings ${(model ?? 'all').padEnd(12)} p${p} ${String(cards.length).padStart(3)} cards, +${added} (pool ${out.size})`);
        if (added === 0) break;
        if (p < 3) await new Promise((r) => setTimeout(r, GAP_MS));
      }
    }

    return [...out.values()].map(makeListing);
  },
};
