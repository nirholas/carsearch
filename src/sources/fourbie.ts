import type { SourceAdapter, Listing } from '../core/types.js';
import { makeListing, type ListingDraft } from '../core/listing.js';
import { getSource } from './registry.js';
import { fetchWithTls } from '../transport/tls.js';
import { parseYear, parseMake, parseModel, isRoundedMileage } from '../core/normalize.js';
import { parseTransmission, parseDrivetrain } from '../core/facets.js';
import { mileageFrom, matchesQuery } from './storefronts.js';

/**
 * Fourbie Exchange: a marketplace for imported 4x4s, vans and kei trucks.
 *
 * It is the one place in this segment where private sellers and small importers
 * list side by side with a location on every card, which is exactly what a
 * buyer shopping one state needs and what the importer shops cannot give. It
 * has no API and no catalogue JSON, so the listing cards are read directly; the
 * card classes are named for what they hold (listingCard__price,
 * listingCard__location), which makes them a more stable hook than most markup.
 */

const BASE = 'https://fourbieexchange.com';

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', '#39': "'", '#215': 'x', times: 'x', nbsp: ' ' };
const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&([a-z0-9#]+);/gi, (m, e: string) => ENTITIES[e.toLowerCase()] ?? ' ').replace(/\s+/g, ' ').trim();

export interface FourbieCard {
  url: string;
  title: string;
  price: number | null;
  location: string | null;
  description: string;
  seller: string | null;
  privateParty: boolean;
  image: string | null;
}

/**
 * Every listing card on a results page.
 *
 * Cards are sliced between their starts rather than matched as a whole, so a
 * card whose markup changes shape cannot swallow the next one. A card with no
 * price ("Call for price") is returned with a null price and dropped by the
 * caller, because a missing number is not a cheap truck.
 */
export function parseCards(html: string): FourbieCard[] {
  const starts = [...html.matchAll(/<div class="vert-card card listingCard/g)].map((m) => m.index!);
  const cards: FourbieCard[] = [];
  for (const [i, start] of starts.entries()) {
    const chunk = html.slice(start, starts[i + 1] ?? start + 6000);
    const url = chunk.match(/href="(https:\/\/fourbieexchange\.com\/listing\/[^"]+)"/)?.[1];
    const title = text(chunk.match(/listingCard__title[^>]*>([\s\S]*?)<\/h5>/)?.[1] ?? '');
    if (!url || !title) continue;
    const priceText = text(chunk.match(/listingCard__price[^>]*>([\s\S]*?)<\/h4>/)?.[1] ?? '');
    const digits = priceText.replace(/[^\d]/g, '');
    const sellerMeta = text(chunk.match(/listingCard__sellerMeta">([\s\S]*?)<\/span>\s*<\/div>/)?.[1] ?? '');
    const img = chunk.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null;
    cards.push({
      url,
      title,
      price: digits ? Number(digits) : null,
      location: text(chunk.match(/listingCard__location[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '') || null,
      description: text(chunk.match(/listingCard__description[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ''),
      seller: sellerMeta || null,
      privateParty: /private/i.test(chunk),
      image: img ? (img.startsWith('http') ? img : `${BASE}${img}`) : null,
    });
  }
  return cards;
}

/**
 * "11K mi" is how these cards write mileage. The shared parser needs a full
 * number and a unit, so the thousands shorthand is expanded first; without it a
 * card reading "11K mi" is stored as eleven miles.
 */
export function cardMileage(description: string): number | null {
  const k = description.match(/(\d+(?:\.\d+)?)\s*k\s*(mi|miles|km)\b/i);
  if (k) {
    const value = Math.round(Number(k[1]) * 1000);
    return /^k/i.test(k[2]!) ? Math.round(value * 0.621371) : value;
  }
  return mileageFrom(description);
}

export const fourbie: SourceAdapter = {
  source: getSource('fourbie')!,

  async search(query, ctx): Promise<Listing[]> {
    const now = new Date().toISOString();
    const out = new Map<string, ListingDraft>();
    let unpriced = 0;

    try {
      const res = await fetchWithTls(`${BASE}/listings?vehicle_type=kei-trucks`);
      if (res.status !== 200) {
        ctx.log(`fourbie HTTP ${res.status}`);
        return [];
      }
      for (const card of parseCards(res.body ?? '')) {
        if (card.price === null) { unpriced += 1; continue; }
        const make = parseMake(card.title);
        const model = parseModel(card.title, make);
        if (!matchesQuery(query, make, model, card.title)) continue;
        const slug = card.url.split('/listing/')[1] ?? card.url;
        const id = `fourbie:${slug}`;
        const miles = cardMileage(card.description);
        out.set(id, {
          id,
          sourceId: 'fourbie',
          sourceListingId: slug,
          url: card.url,
          title: card.title,
          year: parseYear(card.title),
          make,
          model,
          trim: null,
          series: null,
          vin: null,
          price: card.price,
          priceKind: 'ask',
          currency: 'USD',
          mileage: miles,
          mileageIsRounded: isRoundedMileage(miles),
          location: card.location,
          sellerType: card.privateParty ? 'private' : 'dealer',
          dealerName: card.privateParty ? null : card.seller,
          transmission: parseTransmission(card.description),
          drivetrain: parseDrivetrain(card.description),
          eventDate: null,
          imageUrl: card.image,
          firstSeen: now,
          lastSeen: now,
          raw: { description: card.description, seller: card.seller ?? undefined },
        });
      }
    } catch (e) {
      ctx.log(`fourbie FAILED: ${(e as Error).message.split('\n')[0]}`);
    }

    ctx.log(`fourbie: ${out.size} kei trucks${unpriced ? `, ${unpriced} without a price` : ''}`);
    return [...out.values()].map(makeListing);
  },
};
