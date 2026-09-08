/**
 * One spelling per value.
 *
 * Sources describe the same thing in different words, and a facet that carries
 * both is worse than useless: it splits the counts, it offers the user two
 * chips that mean one thing, and picking either silently hides half the market.
 * The index held "SUV" and "Suv" as separate values, and "Macan" and "macan"
 * before that.
 *
 * Worse than a split is a value that is simply the wrong KIND of thing. The EPA
 * reports fuel as "Premium" and "Regular", which are grades of petrol, not fuel
 * types, so a fuel facet built from it offered "Premium" beside "Electricity"
 * as though a buyer might choose between them.
 *
 * Unrecognized values are passed through with their case tidied rather than
 * dropped. A vocabulary that silently deletes what it has not seen is how a
 * facet quietly loses a whole category of car.
 */

function titleCase(s: string): string {
  return s.trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Coerces whatever a source handed us into a string, or null.
 *
 * These functions are called with values straight off a JSON payload, and a
 * field that is a string on one site is an object on another: duPont Registry
 * returns an object where every other source returns a colour name, and the
 * adapter died on `raw?.trim is not a function` before a single row was read.
 * A normalizer that crashes on an unexpected shape takes the whole source down
 * with it, which is a poor trade for a field nobody filters on.
 */
function asText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const key of ['name', 'value', 'label', 'text', 'description']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

const BODY_TYPES: [RegExp, string][] = [
  [/\b(pickup|truck|crew ?cab|reg(ular)? ?cab|ext(ended)? ?cab)\b/i, 'Truck'],
  [/\b(sport ?utility|suv|mpv|multipurpose|crossover|cuv)\b/i, 'SUV'],
  [/\b(convertible|cabriolet|cabrio|roadster|spyder|spider|targa|drop ?top)\b/i, 'Convertible'],
  [/\b(coupe|coup[eé]|2 ?door|two ?door|fastback|hardtop)\b/i, 'Coupe'],
  [/\b(hatch(back)?|liftback|5 ?door)\b/i, 'Hatchback'],
  [/\b(wagon|estate|shooting ?brake|avant|touring|sportbrake)\b/i, 'Wagon'],
  [/\b(mini ?van|van|cargo ?van|passenger ?van)\b/i, 'Van'],
  [/\b(sedan|saloon|4 ?door|four ?door|berlina)\b/i, 'Sedan'],
  [/\b(chassis|cab ?chassis|incomplete)\b/i, 'Chassis'],
];

/**
 * Values that name a vehicle rather than a body style.
 *
 * Copart returns "AUTOMOBILE" for anything that is not a truck or a bike, and
 * a body-style facet offering "Automobile" beside "Coupe" is offering a
 * category that means "car", which is every row. An unknown body style is
 * more useful than a fake one, because the UI already reports coverage.
 */
const NOT_A_BODY_STYLE = /^(automobile|vehicle|car|passenger|other|unknown|n\/?a|none)$/i;

export function canonicalBodyType(raw: unknown): string | null {
  const s = asText(raw);
  if (!s || NOT_A_BODY_STYLE.test(s)) return null;
  for (const [pattern, canonical] of BODY_TYPES) if (pattern.test(s)) return canonical;
  return titleCase(s);
}

const FUEL_TYPES: [RegExp, string][] = [
  // Order matters: "Plug-in Hybrid" must not be read as "Hybrid", and every
  // petrol GRADE has to resolve to petrol rather than standing as its own type.
  [/\b(plug[\s-]?in|phev)\b/i, 'Plug-in Hybrid'],
  [/\b(hybrid|hev)\b/i, 'Hybrid'],
  [/\b(electric|electricity|bev|ev)\b/i, 'Electric'],
  [/\b(hydrogen|fuel ?cell|fcev)\b/i, 'Hydrogen'],
  [/\b(diesel|tdi|cdi|bluetec)\b/i, 'Diesel'],
  [/\b(e85|flex[\s-]?fuel|ethanol)\b/i, 'Flex Fuel'],
  [/\b(cng|natural ?gas|lpg|propane)\b/i, 'Natural Gas'],
  [/\b(premium|regular|midgrade|mid[\s-]?grade|unleaded|gasoline|petrol|gas)\b/i, 'Gasoline'],
];

const PETROL = /\b(premium|regular|midgrade|mid[\s-]?grade|unleaded|gasoline|petrol|gas)\b/i;
const ELECTRIC = /\b(electric|electricity|bev)\b/i;

export function canonicalFuelType(raw: unknown): string | null {
  const s = asText(raw);
  if (!s) return null;

  /**
   * A car that burns petrol AND takes a charge is a plug-in hybrid.
   *
   * The EPA writes this as "Premium and Electricity". Reading it in rule order
   * matches "Electricity" and labels the car Electric, which tells a buyer it
   * has no engine. 101 rows in the index would have been wrong that way.
   */
  if (PETROL.test(s) && ELECTRIC.test(s)) return 'Plug-in Hybrid';

  for (const [pattern, canonical] of FUEL_TYPES) if (pattern.test(s)) return canonical;
  return titleCase(s);
}

/**
 * Colours are reduced to a basic family, and the original is kept elsewhere.
 *
 * Manufacturers name paint for marketing: "Uyuni White", "Albert Blue",
 * "Chalk". Those are useful to read and useless to filter on, because every one
 * is unique to a model. The facet needs the family; the listing still shows the
 * name the seller used.
 */
const COLOUR_FAMILIES: [RegExp, string][] = [
  [/\b(black|noir|nero|schwarz|onyx|obsidian|jet)\b/i, 'Black'],
  [/\b(white|blanc|bianco|wei[sß]|pearl|ivory|chalk|alabaster)\b/i, 'White'],
  [/\b(silver|argento|platinum|titanium|aluminium|aluminum)\b/i, 'Silver'],
  [/\b(gr[ae]y|grigio|graphite|gunmetal|slate|charcoal|anthracite)\b/i, 'Gray'],
  [/\b(blue|bleu|blu|azure|navy|cobalt|sapphire|marine)\b/i, 'Blue'],
  [/\b(red|rouge|rosso|rot|crimson|burgundy|maroon|carmine|scarlet)\b/i, 'Red'],
  [/\b(green|vert|verde|emerald|olive|british racing)\b/i, 'Green'],
  [/\b(brown|marron|chocolate|espresso|mocha|walnut|cognac)\b/i, 'Brown'],
  [/\b(beige|tan|sand|cream|champagne|almond|linen)\b/i, 'Beige'],
  [/\b(gold|dorado)\b/i, 'Gold'],
  [/\b(orange|arancio|copper|bronze)\b/i, 'Orange'],
  [/\b(yellow|jaune|giallo|gelb)\b/i, 'Yellow'],
  [/\b(purple|violet|viola|plum|aubergine)\b/i, 'Purple'],
  [/\b(pink|rose)\b/i, 'Pink'],
];

export function canonicalColor(raw: unknown): string | null {
  const s = asText(raw);
  if (!s) return null;
  for (const [pattern, family] of COLOUR_FAMILIES) if (pattern.test(s)) return family;
  return titleCase(s);
}

/** A blank string is not a value, and neither is a value that is only punctuation. */
export function blankToNull(raw: unknown): string | null {
  const s = asText(raw);
  if (!s) return null;
  return /[a-z0-9]/i.test(s) ? s : null;
}
