import type { SearchQuery, PriceKind } from '../core/types.js';
import { loadVocabulary, NICKNAMES } from './vocabulary.js';

/**
 * Deterministic natural-language query parsing.
 *
 * This runs on every query, with no API key, no network call and no latency
 * budget. It is not a fallback for the model-backed parser: it is the primary,
 * because most real searches are a make, a model and a budget, and paying a
 * round trip to a language model to extract "porsche macan under 40k" would be
 * slower and worse than a regular expression.
 *
 * It also reports what it understood. A search box that silently reinterprets
 * the request is worse than one that asks, so every extracted constraint comes
 * back with a human-readable explanation the UI can show and the user can
 * correct.
 */

export interface ParsedQuery {
  query: SearchQuery;
  /** One line per constraint understood, for display back to the user. */
  interpretation: string[];
  /** Words that contributed nothing, kept as a text match rather than discarded. */
  leftover: string;
  /** False when nothing at all was recognized, which the caller may escalate to the model parser. */
  confident: boolean;
}

const THIS_YEAR = new Date().getFullYear();

/** "old" and "new" are relative, so they are defined once here rather than guessed per site. */
const OLD_THRESHOLD_YEARS = 15;
const NEW_THRESHOLD_YEARS = 3;

/**
 * Phrases that ask for an ordering rather than a filter.
 *
 * Longest and most specific first: "lowest mileage and cheapest" must not be
 * consumed by the bare "cheapest" rule, or the mileage half of the request
 * disappears without a trace.
 */
const SORT_INTENTS: { pattern: RegExp; sort: string; explain: string }[] = [
  {
    pattern: /\b(?:lowest|least|fewest|lowest)\s*(?:mileage|miles|mile)\b[\s,]*(?:and|with|plus|&)?\s*\b(?:cheapest|lowest priced?|lowest price|best priced?|least expensive)\b/,
    sort: 'mileage+price',
    explain: 'Ranked by lowest mileage and lowest price together, showing which cars nothing beats on both',
  },
  {
    pattern: /\b(?:cheapest|lowest priced?|lowest price|least expensive)\b[\s,]*(?:and|with|plus|&)?\s*\b(?:lowest|least|fewest|lowest)\s*(?:mileage|miles|mile)\b/,
    sort: 'mileage+price',
    explain: 'Ranked by lowest mileage and lowest price together, showing which cars nothing beats on both',
  },
  {
    pattern: /\b(?:best|biggest)\s*(?:deal|price)\s*(?:vs|versus|against|compared to)\s*(?:market|sold|comps?)\b/,
    sort: 'deal',
    explain: 'Ranked against completed sale prices',
  },
  {
    pattern: /\b(?:best|biggest|greatest)\s*(?:value|deals?|bargains?|discounts?)\b/,
    sort: 'value',
    explain: 'Ranked by value: furthest below what these actually sell for, with low miles',
  },
  {
    pattern: /\b(?:lowest|least|fewest|lowest)\s*(?:mileage|miles)\b/,
    sort: 'mileage',
    explain: 'Ranked by lowest mileage',
  },
  {
    pattern: /\b(?:cheapest|lowest priced?|lowest price|least expensive)\b/,
    sort: 'price',
    explain: 'Ranked by lowest price',
  },
  {
    pattern: /\b(?:newest|latest|most recent)\s*(?:year|model year|model)\b/,
    sort: 'year',
    explain: 'Ranked by newest model year',
  },
  {
    pattern: /\b(?:oldest|earliest)\s*(?:year|model year|model)?\b/,
    sort: 'age',
    explain: 'Ranked by oldest model year',
  },
  {
    pattern: /\b(?:just listed|newly listed|recently listed|new listings?)\b/,
    sort: 'newest',
    explain: 'Ranked by most recently listed',
  },
  {
    pattern: /\b(?:longest|been)\s*(?:on the market|listed|sitting|unsold)\b/,
    sort: 'days-on-market',
    explain: 'Ranked by longest on the market, where a seller is most likely to negotiate',
  },
];

const BODY_TYPES: Record<string, string> = {
  suv: 'SUV', crossover: 'SUV', truck: 'Truck', pickup: 'Truck', sedan: 'Sedan',
  coupe: 'Coupe', convertible: 'Convertible', cabriolet: 'Convertible', roadster: 'Convertible',
  wagon: 'Wagon', estate: 'Wagon', hatchback: 'Hatchback', hatch: 'Hatchback',
  van: 'Van', minivan: 'Van',
};

const FUEL_TYPES: Record<string, string> = {
  electric: 'Electric', ev: 'Electric', hybrid: 'Hybrid', phev: 'Hybrid',
  diesel: 'Diesel', gas: 'Gasoline', gasoline: 'Gasoline', petrol: 'Gasoline',
};

/** Turns "40k", "40,000", "$40k" into 40000. */
function money(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, '').toLowerCase();
  const k = cleaned.match(/^(\d+(?:\.\d+)?)k$/);
  if (k?.[1]) return Math.round(Number(k[1]) * 1000);
  const n = Number(cleaned);
  // A bare number under 1000 in a price context is nearly always thousands:
  // nobody searches for a $40 car, and "under 40" means $40,000.
  return n < 1000 ? n * 1000 : n;
}

function miles(raw: string): number {
  const cleaned = raw.replace(/[,\s]/g, '').toLowerCase();
  const k = cleaned.match(/^(\d+(?:\.\d+)?)k$/);
  if (k?.[1]) return Math.round(Number(k[1]) * 1000);
  const n = Number(cleaned);
  return n < 1000 ? n * 1000 : n;
}

export function parseQuery(text: string): ParsedQuery {
  const vocab = loadVocabulary();
  const original = text.trim();
  let t = ` ${original.toLowerCase()} `;
  const query: SearchQuery = {};
  const interpretation: string[] = [];

  /** Removes a matched phrase so it cannot be matched again by a later rule. */
  const consume = (match: string) => {
    t = t.replace(match.toLowerCase(), ' ');
  };


  /* --- Sort intent --------------------------------------------------------
   *
   * Read before the price and mileage filters, and consumed, because the two
   * are easy to confuse and the failure is silent. "lowest mileage" is a
   * ranking; "low miles" is a filter. Reading the first as the second caps the
   * results at 40,000 miles and hides every car the user actually asked to see
   * ranked, while still returning a plausible page.
   */
  for (const rule of SORT_INTENTS) {
    const hit = t.match(rule.pattern);
    if (!hit) continue;
    query.sort = rule.sort;
    interpretation.push(rule.explain);
    consume(hit[0]);
    break;
  }

  // --- Intent: asking prices, or what things actually sold for -------------
  const kinds: PriceKind[] = [];
  const soldIntent = t.match(/\b(sold for|sell for|selling for|went for|sale price|sold|comps?|actually paid|market value|worth)\b/);
  if (soldIntent?.[1]) {
    kinds.push('sold');
    interpretation.push('Showing completed sales rather than asking prices');
    consume(soldIntent[1]);
  }
  const auctionIntent = t.match(/\b(auctions?|bidding|current bid|live auction)\b/);
  if (auctionIntent?.[1]) {
    kinds.push('bid', 'sold');
    interpretation.push('Including auctions');
    consume(auctionIntent[1]);
  }
  if (kinds.length) query.priceKinds = [...new Set(kinds)];

  // --- Nicknames first, since they are the most specific and often multi-word.
  const nicknameKeys = Object.keys(NICKNAMES).sort((a, b) => b.length - a.length);
  for (const key of nicknameKeys) {
    if (!t.includes(` ${key} `) && !t.includes(`${key} `) && !t.includes(` ${key}`)) continue;
    const hit = NICKNAMES[key]!;
    if (!query.make) {
      query.make = hit.make;
      if (hit.model) query.models = [hit.model];
      const isRealNickname = key !== hit.make.toLowerCase() && key !== hit.model?.toLowerCase();
      interpretation.push(
        isRealNickname
          ? hit.model
            ? `"${key}" means a ${hit.make} ${hit.model}`
            : `"${key}" means ${hit.make}`
          : hit.model
            ? `Make and model: ${hit.make} ${hit.model}`
            : `Make: ${hit.make}`,
      );
      consume(` ${key} `);
      break;
    }
  }

  // --- Catalogue makes and models -----------------------------------------
  if (!query.make) {
    const makeHit = [...vocab.makes].sort((a, b) => b.length - a.length).find((m) => t.includes(` ${m} `) || t.includes(` ${m}`));
    if (makeHit) {
      query.make = makeHit.replace(/\b\w/g, (c) => c.toUpperCase());
      interpretation.push(`Make: ${query.make}`);
      consume(` ${makeHit} `);
    }
  }
  if (query.make && !query.models?.length) {
    const list = vocab.models[query.make.toLowerCase()] ?? [];
    const found = [...list]
      .sort((a, b) => b.length - a.length)
      .filter((m) => t.includes(m.toLowerCase()));
    if (found.length) {
      query.models = found;
      interpretation.push(`Model: ${found.join(', ')}`);
      for (const m of found) consume(m.toLowerCase());
    }
  }

  // --- Price ---------------------------------------------------------------
  const between = t.match(/between\s+\$?([\d.,]+k?)\s+(?:and|to|-)\s+\$?([\d.,]+k?)/);
  if (between?.[1] && between[2]) {
    query.priceMin = money(between[1]);
    query.priceMax = money(between[2]);
    interpretation.push(`Price $${query.priceMin.toLocaleString()} to $${query.priceMax.toLocaleString()}`);
    consume(between[0]);
  } else {
    const under = t.match(/(?:under|below|less than|max|up to|cheaper than|<)\s*\$?([\d.,]+k?)\b(?!\s*(?:miles|mi|k?\s*miles))/);
    if (under?.[1]) {
      query.priceMax = money(under[1]);
      interpretation.push(`Price under $${query.priceMax.toLocaleString()}`);
      consume(under[0]);
    }
    const over = t.match(/(?:over|above|more than|at least|min|>)\s*\$?([\d.,]+k?)\b(?!\s*(?:miles|mi))/);
    if (over?.[1]) {
      query.priceMin = money(over[1]);
      interpretation.push(`Price over $${query.priceMin.toLocaleString()}`);
      consume(over[0]);
    }
  }
  const cheap = t.match(/\b(cheap|budget|affordable|bargain)\b/);
  if (query.priceMax === undefined && cheap?.[1]) {
    query.priceMax = 15000;
    interpretation.push(`"${cheap[1]}" read as under $15,000`);
  }
  if (cheap?.[1]) consume(cheap[1]);

  // --- Mileage -------------------------------------------------------------
  const mileage = t.match(/(?:under|below|less than|max|<)\s*([\d.,]+k?)\s*(?:miles|mi|k miles)\b/);
  if (mileage?.[1]) {
    query.mileageMax = miles(mileage[1]);
    interpretation.push(`Mileage under ${query.mileageMax.toLocaleString()}`);
    consume(mileage[0]);
  } else {
    const low = t.match(/\blow (?:miles|mileage)\b/);
    if (low) {
      query.mileageMax = 40000;
      interpretation.push('"low miles" read as under 40,000');
      consume(low[0]);
    }
  }

  // --- Year ----------------------------------------------------------------
  const yearRange = t.match(/\b(19[5-9]\d|20[0-4]\d)\s*(?:-|to|through|thru)\s*(19[5-9]\d|20[0-4]\d)\b/);
  const yearOrNewer = t.match(/\b(19[5-9]\d|20[0-4]\d)\s*(?:or newer|\+|and up|and newer)\b/);
  const yearOrOlder = t.match(/\b(19[5-9]\d|20[0-4]\d)\s*(?:or older|and older|and down)\b/);
  if (yearRange?.[1] && yearRange[2]) {
    query.yearMin = Number(yearRange[1]);
    query.yearMax = Number(yearRange[2]);
    interpretation.push(`Years ${query.yearMin} to ${query.yearMax}`);
    consume(yearRange[0]);
  } else if (yearOrNewer?.[1]) {
    query.yearMin = Number(yearOrNewer[1]);
    interpretation.push(`Year ${query.yearMin} or newer`);
    consume(yearOrNewer[0]);
  } else if (yearOrOlder?.[1]) {
    query.yearMax = Number(yearOrOlder[1]);
    interpretation.push(`Year ${query.yearMax} or older`);
    consume(yearOrOlder[0]);
  } else {
    const single = t.match(/\b(19[5-9]\d|20[0-4]\d)\b/);
    if (single?.[1]) {
      const y = Number(single[1]);
      query.yearMin = y;
      query.yearMax = y;
      interpretation.push(`Year ${y}`);
      consume(single[0]);
    }
  }

  // "old" and "new" carry a real constraint, so they are resolved to explicit
  // years and shown, rather than quietly reinterpreted.
  const oldWord = t.match(/\b(old|older|classic|vintage|retro)\b/);
  if (query.yearMax === undefined && oldWord?.[1]) {
    query.yearMax = THIS_YEAR - OLD_THRESHOLD_YEARS;
    interpretation.push(`"${oldWord[1]}" read as ${query.yearMax} or earlier`);
  }
  if (oldWord?.[1]) consume(oldWord[1]);

  const newWord = t.match(/\b(newer|new|late model|recent)\b/);
  if (query.yearMin === undefined && newWord?.[1]) {
    query.yearMin = THIS_YEAR - NEW_THRESHOLD_YEARS;
    interpretation.push(`"${newWord[1]}" read as ${query.yearMin} or later`);
  }
  if (newWord?.[1]) consume(newWord[1]);

  // --- Body and fuel -------------------------------------------------------
  for (const [word, canonical] of Object.entries(BODY_TYPES)) {
    if (new RegExp(`\\b${word}s?\\b`).test(t)) {
      query.bodyType = canonical;
      interpretation.push(`Body style: ${canonical}`);
      consume(word);
      break;
    }
  }
  for (const [word, canonical] of Object.entries(FUEL_TYPES)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      query.fuelType = canonical;
      interpretation.push(`Fuel: ${canonical}`);
      consume(word);
      break;
    }
  }

  // --- Location ------------------------------------------------------------
  const zip = t.match(/\b(\d{5})\b/);
  if (zip?.[1]) {
    query.zip = zip[1];
    interpretation.push(`Near ${zip[1]}`);
    consume(zip[0]);
  }

  const noise =
    /\b(a|an|the|for|sale|me|my|i|want|wanted|need|needs|find|finding|looking|look|show|get|buy|with|without|and|or|but|in|on|at|to|of|near|around|any|some|car|cars|vehicle|used|new|please|that|this|it|is|are|was|were|be|do|does|did|whats|what|which|how|much|worth|good|nice|really|just|about|under|over|between|miles|mile|mi|k)\b/g;
  const leftover = t
    .replace(noise, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // A single stray token is far more likely to be filler the noise list has not
  // seen than a real requirement, and a wrong keyword filter returns nothing at
  // all rather than merely ranking badly. Require something substantial.
  if (leftover.length >= 3 && /[a-z]{3}/.test(leftover)) query.keywords = leftover;

  return {
    query,
    interpretation,
    leftover,
    confident: interpretation.length > 0,
  };
}
