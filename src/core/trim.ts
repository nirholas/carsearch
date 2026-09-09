import { loadVocabulary } from '../nl/vocabulary.js';

/**
 * Trim, parsed from the title when the source did not supply one.
 *
 * A model name is not enough to compare two cars. A 2016 Cayman ranges from
 * $50,998 to $124,999 in this index, and the spread is not condition or
 * mileage: eighteen of those twenty cars are GT4s and the rest are base cars.
 * Any statistic computed over "2016 Cayman" is therefore computed over two
 * different vehicles, and its lower quartile sits in the middle of the
 * expensive cluster. That silently breaks cohort medians, price-floor checks
 * and peer grouping, and it breaks them in the direction of confident wrong
 * answers rather than visible failures.
 *
 * Most sources leave `trim` null while writing the variant into the title in
 * plain sight ("2016 Cayman 981 GT4", "2020 Corvette Stingray w/2LT"). This
 * reads it back out.
 *
 * Scope is deliberate. This does not attempt every trim in existence; it
 * targets the variants that MOVE PRICE, which is a much shorter list and the
 * only one that matters for cohorting. An unrecognised variant returns null
 * rather than a guess, because a wrong trim splits a cohort as badly as a
 * missing one merges two.
 */

/**
 * Body style, drivetrain and door count are not trims.
 *
 * These arrive appended by dealer feeds ("Coupe 2D", "Sport Utility 4D") and
 * would otherwise become the answer, producing cohorts keyed on bodywork.
 */
const NOISE = new RegExp(
  String.raw`\b(` +
    String.raw`sport utility|station wagon|hatchback|convertible|cabriolet|roadster|coupe|sedan|wagon|suv|` +
    String.raw`\d\s?d(?:r|oor)?s?|awd|rwd|fwd|4wd|4matic|xdrive|quattro|` +
    String.raw`automatic|manual|tiptronic|pdk|dct|` +
    String.raw`w/[a-z0-9]+|used|new|certified|cpo` +
  String.raw`)\b`,
  'gi',
);

/**
 * Variants that move price, longest first within each make.
 *
 * Order is load-bearing at match time: "Turbo S" must be tested before
 * "Turbo", "GT4 RS" before "GT4", and "Carrera 4S" before both "Carrera 4" and
 * "Carrera", or every higher trim collapses into the cheaper one it contains.
 * The sort at the bottom of this file enforces that rather than relying on the
 * order anyone happens to type here.
 */
const TRIMS: Record<string, string[]> = {
  porsche: [
    'GT4 RS', 'GT3 RS', 'GT2 RS', 'GT4', 'GT3', 'GT2',
    'Turbo S', 'Turbo',
    'Carrera 4S', 'Carrera 4 GTS', 'Carrera GTS', 'Carrera 4', 'Carrera S', 'Carrera T', 'Carrera',
    'Targa 4S', 'Targa 4', 'Targa',
    'Spyder RS', 'Spyder', 'Speedster', 'Dakar', 'Sport Turismo', 'Cross Turismo',
    'GTS 4.0', 'GTS',
    // Named editions only. A bare 'Edition' would read "Wombat Edition" as
    // "Edition" and merge every unknown special into one bucket, which is the
    // GT4 problem mirrored: collapsing distinct cars instead of splitting one.
    // Panamera Edition is the real casualty and it sits with the base cars.
    'Black Edition', 'Style Edition', 'Platinum Edition', 'Sport Edition',
    'Executive', '4S', '4', 'S',
    // The 718 T is a real variant and a real price step. A single letter is only
    // safe because the model has already been stripped from the remainder, so
    // "718 Boxster T" reduces to "T" and nothing else can reach this.
    'T',
  ],
  chevrolet: ['ZR1', 'Z06', 'E-Ray', 'Grand Sport', 'Stingray', 'SS', 'ZL1', 'Z51'],
  audi: ['RS 5', 'RS 7', 'V10 Performance', 'V10 Plus', 'V10 Spyder', 'V10', 'V8', 'Prestige', 'Premium Plus'],
  bmw: [
    // The i8 special editions carry a real premium over a base i8 and were
    // landing in the base cohort with it.
    'Protonic Frozen Yellow Edition', 'Protonic Frozen Black Edition',
    'Protonic Red Edition', 'Protonic Blue Edition', 'Protonic Silver Edition',
    'Competition', 'CS', 'CSL', 'M Sport', 'xDrive50i', 'sDrive',
  ],
  'mercedes-benz': ['AMG GT R', 'AMG GT S', 'Black Series', 'AMG', 'Maybach', '4x4 Squared'],
  lamborghini: ['Performante', 'Tecnica', 'STO', 'SVJ', 'SV', 'EVO', 'LP 610-4', 'LP 580-2', 'Spyder', 'Roadster'],
  ferrari: ['Pista', 'Speciale', 'Aperta', 'Spider', 'Lusso', 'GTS', 'GTB', 'Scuderia'],
  mclaren: ['LT Spider', 'LT', 'Spider', 'S', 'GT'],
  // 'GT' is deliberately absent: "Continental GT" is the MODEL, and reading it
  // as a trim assigns the same value to the V8, the W12 and the Speed, which
  // are the three cars whose prices actually differ.
  bentley: ['W12 Onyx Edition', 'Onyx Edition', 'First Edition', 'Mulliner', 'Speed', 'Azure', 'W12', 'GTC', 'V8', 'S'],
  aston: ['Vantage S', 'Superleggera', 'Volante', 'S'],
  nissan: ['NISMO', 'Track Edition', 'Premium'],
  toyota: ['TRD Pro', 'TRD', 'Limited', 'Platinum'],
  ford: ['Shelby GT500', 'Shelby GT350', 'Raptor', 'Mach 1', 'Bullitt', 'ST', 'RS'],
};

/** Matched case-insensitively but stored in the canonical casing above. */
const COMPILED: Record<string, { canonical: string; re: RegExp }[]> = Object.fromEntries(
  Object.entries(TRIMS).map(([make, list]) => [
    make,
    [...list]
      // Longest first so a trim never loses to a shorter trim inside it.
      .sort((a, b) => b.length - a.length)
      .map((t) => ({
        canonical: t,
        re: new RegExp(String.raw`(?:^|[\s,(-])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\s,)-])`, 'i'),
      })),
  ]),
);

/**
 * Strip the year, make and model so their own words cannot be read as a trim.
 *
 * "2016 Porsche Macan Macan S" repeats the model, and "Ferrari 488 GTB" has a
 * model whose name would otherwise survive into the remainder.
 */
function remainder(title: string, make: string | null, model: string | null): string {
  let s = ` ${title} `;
  const drop = (term: string | null) => {
    if (!term) return;
    const re = new RegExp(String.raw`\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'gi');
    s = s.replace(re, ' ');
  };
  s = s.replace(/\b(19|20)\d{2}(?:\.\d)?\b/g, ' ');
  drop(make);
  // Multi-word models are dropped whole first, then token by token, so
  // "718 Cayman" cannot leave a stray "718" behind to be read as a trim.
  drop(model);
  if (model) for (const part of model.split(/\s+/)) drop(part);
  return s.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Which make's trim table to use when the row does not state a make.
 *
 * A sixth of this index arrives with `make` null while naming a model that
 * identifies the marque outright, and those rows are not a random sample: the
 * 2016 Cayman cohort that motivated this file is entirely make-null, so a trim
 * parser keyed on make alone returns nothing exactly where it is needed most.
 *
 * The model is resolved against the vocabulary, and only a model that belongs
 * to exactly one make is accepted. An ambiguous model gets no trim rather than
 * a trim borrowed from the wrong marque, because "S" and "GT" mean different
 * cars in different tables.
 */
let makeByModel: Map<string, string | null> | null = null;
function inferMake(model: string | null): string | null {
  if (!model) return null;
  if (!makeByModel) {
    makeByModel = new Map();
    for (const [make, models] of Object.entries(loadVocabulary().models)) {
      if (!COMPILED[make]) continue;              // only makes with a trim table
      for (const m of models) {
        const k = m.toLowerCase();
        // Second make claiming the same model poisons it to null, permanently.
        makeByModel.set(k, makeByModel.has(k) ? null : make);
      }
    }
  }
  return makeByModel.get(model.toLowerCase()) ?? null;
}

export function parseTrim(title: string, make: string | null, model: string | null): string | null {
  if (!title) return null;
  const stated = make?.toLowerCase().replace(/[^a-z-]/g, '') ?? '';
  const key = COMPILED[stated] ? stated : (inferMake(model) ?? stated);
  const table = COMPILED[key] ?? COMPILED[key.split('-')[0] ?? ''];
  if (!table) return null;

  const rest = remainder(title, make, model);
  if (!rest) return null;

  const hit = table.find((t) => t.re.test(rest));
  return hit ? hit.canonical : null;
}

/**
 * The trim as it should be stored, given what the source claimed.
 *
 * Mirrors `resolveModel`. A source-supplied trim wins, because a feed field is
 * better evidence than a string match, but "base" is discarded: it is the
 * absence of a trim written as a word, and keeping it creates a cohort that
 * splits from the null-trim cars that are the same vehicle.
 */
export function resolveTrim(
  title: string,
  make: string | null,
  model: string | null,
  claimed: string | null,
): string | null {
  const c = claimed?.trim();
  if (c && !/^base$/i.test(c)) return c;
  return parseTrim(title, make, model);
}
