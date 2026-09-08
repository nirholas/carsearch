/**
 * Multi-criteria ranking.
 *
 * A single ORDER BY column answers "the cheapest car". It cannot answer the
 * question people actually ask, which is "the lowest mileage one that is also
 * cheap, in this year". Those are two objectives pulling against each other,
 * and there is no single column that expresses the trade-off.
 *
 * Two mechanisms here, and they answer different halves of the question.
 *
 *  1. A blended score. Each requested dimension is converted to a percentile
 *     WITHIN THE RESULT SET, then averaged with weights. Percentiles rather
 *     than raw values because the units are incomparable (dollars against
 *     miles) and because one $400,000 outlier would otherwise flatten the
 *     entire price axis. This gives a total order, so the list can be painted.
 *
 *  2. A Pareto frontier. A car is on the frontier when no other car in the set
 *     beats it on every requested dimension at once. That is the exact,
 *     weighting-free answer to "lowest mileage and lowest price": the frontier
 *     is the set where you cannot improve one without giving up the other, and
 *     everything behind it is strictly worse than something on it. No incumbent
 *     surfaces this, and it needs no arbitrary weights to be true.
 *
 * The frontier orders the list into layers; the blended score orders within a
 * layer. So the top of the page is provably undominated, and the ordering
 * inside it is still sensible.
 */

/** The row shape ranking needs. Anything with these fields can be ranked. */
export interface RankInput {
  id: string;
  price: number | null;
  mileage: number | null;
  year: number | null;
  firstSeen: string;
  daysOnMarket?: number | null;
  /** Percent above/below the sold median. Negative is a better deal. Null when unrated. */
  dealPercent?: number | null;
}

export type DimensionKey =
  | 'price'
  | 'mileage'
  | 'year'
  | 'age'
  | 'listed'
  | 'days-on-market'
  | 'deal';

interface Dimension {
  /** Used in the "understood as" line and the per-card explanation. */
  label: string;
  /** Noun used when quoting a rank, e.g. "3rd lowest mileage". */
  superlative: string;
  better: 'low' | 'high';
  value: (r: RankInput) => number | null;
}

export const DIMENSIONS: Record<DimensionKey, Dimension> = {
  price: { label: 'lowest price', superlative: 'lowest price', better: 'low', value: (r) => r.price },
  mileage: { label: 'lowest mileage', superlative: 'lowest mileage', better: 'low', value: (r) => r.mileage },
  year: { label: 'newest model year', superlative: 'newest', better: 'high', value: (r) => r.year },
  age: { label: 'oldest model year', superlative: 'oldest', better: 'low', value: (r) => r.year },
  listed: {
    label: 'most recently listed',
    superlative: 'most recently listed',
    better: 'high',
    value: (r) => {
      const t = Date.parse(r.firstSeen);
      return Number.isFinite(t) ? t : null;
    },
  },
  'days-on-market': {
    label: 'longest on the market',
    superlative: 'longest listed',
    better: 'high',
    value: (r) => r.daysOnMarket ?? null,
  },
  deal: {
    label: 'furthest below what these actually sell for',
    superlative: 'best deal',
    better: 'low',
    value: (r) => r.dealPercent ?? null,
  },
};

export interface SortTerm {
  key: DimensionKey;
  weight: number;
}

/**
 * Named combinations, so a user never has to type a weighting.
 *
 * `value` weights the deal rating twice, because a car being cheap relative to
 * what its peers actually sold for is a stronger signal than it being cheap in
 * absolute terms: the cheapest listing in a set is usually the highest-mileage
 * one, which is not a bargain, it is a different car.
 */
export const PRESETS: Record<string, { terms: SortTerm[]; label: string }> = {
  price: { terms: [{ key: 'price', weight: 1 }], label: 'Lowest price' },
  mileage: { terms: [{ key: 'mileage', weight: 1 }], label: 'Lowest mileage' },
  year: { terms: [{ key: 'year', weight: 1 }], label: 'Newest model year' },
  age: { terms: [{ key: 'age', weight: 1 }], label: 'Oldest model year' },
  newest: { terms: [{ key: 'listed', weight: 1 }], label: 'Recently listed' },
  listed: { terms: [{ key: 'listed', weight: 1 }], label: 'Recently listed' },
  'days-on-market': { terms: [{ key: 'days-on-market', weight: 1 }], label: 'Longest on the market' },
  deal: { terms: [{ key: 'deal', weight: 1 }], label: 'Best deal against sold prices' },
  'mileage+price': {
    terms: [{ key: 'mileage', weight: 1 }, { key: 'price', weight: 1 }],
    label: 'Lowest mileage and lowest price',
  },
  value: {
    terms: [{ key: 'deal', weight: 2 }, { key: 'mileage', weight: 1 }],
    label: 'Best value: below market and low miles',
  },
  best: {
    terms: [{ key: 'deal', weight: 2 }, { key: 'mileage', weight: 1 }, { key: 'price', weight: 1 }],
    label: 'Best overall: deal, miles and price',
  },
};

export const DEFAULT_SORT = 'price';

/**
 * Reads a sort spec.
 *
 * Accepts a preset name (`value`), or an explicit blend written with `+` and
 * optional weights (`mileage:2+price:1`). A comma is accepted as a synonym for
 * `+` because it is what people type. An unknown key is dropped rather than
 * failing the request, and the caller is told which, so a typo in a URL
 * degrades to a sensible sort instead of a 400.
 */
export function parseSortSpec(spec: string | undefined): {
  terms: SortTerm[];
  label: string;
  ignored: string[];
} {
  const raw = (spec ?? '').trim().toLowerCase();
  if (!raw) return { ...PRESETS[DEFAULT_SORT]!, ignored: [] };

  const preset = PRESETS[raw];
  if (preset) return { ...preset, ignored: [] };

  const ignored: string[] = [];
  const terms: SortTerm[] = [];
  for (const part of raw.split(/[+,]/)) {
    const token = part.trim();
    if (!token) continue;
    const [name = '', weightText] = token.split(':');
    const key = name.trim() as DimensionKey;
    if (!(key in DIMENSIONS)) {
      ignored.push(token);
      continue;
    }
    const weight = weightText === undefined ? 1 : Number(weightText);
    if (terms.some((t) => t.key === key)) continue;
    terms.push({ key, weight: Number.isFinite(weight) && weight > 0 ? weight : 1 });
  }

  if (terms.length === 0) return { ...PRESETS[DEFAULT_SORT]!, ignored };
  return { terms, label: describeTerms(terms), ignored };
}

export function describeTerms(terms: SortTerm[]): string {
  if (terms.length === 1) return capitalize(DIMENSIONS[terms[0]!.key]!.label);
  return capitalize(terms.map((t) => DIMENSIONS[t.key]!.label).join(' and '));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Percentile rank of every row on one dimension, 0 = best.
 *
 * Ties share a percentile, so two identical cars can never be separated by an
 * arbitrary tiebreak that the user would read as meaningful. A missing value
 * scores 1 (worst) rather than 0: a car with no published mileage must not win
 * a lowest-mileage sort by having nothing to show.
 */
export function percentiles(rows: RankInput[], key: DimensionKey): { byId: Map<string, number>; missing: Set<string> } {
  const dim = DIMENSIONS[key]!;
  const byId = new Map<string, number>();
  const missing = new Set<string>();

  const present: { id: string; v: number }[] = [];
  for (const r of rows) {
    const v = dim.value(r);
    if (v === null || v === undefined || !Number.isFinite(v)) {
      missing.add(r.id);
      byId.set(r.id, 1);
    } else {
      present.push({ id: r.id, v: dim.better === 'low' ? v : -v });
    }
  }

  if (present.length === 0) return { byId, missing };
  if (present.length === 1) {
    byId.set(present[0]!.id, 0);
    return { byId, missing };
  }

  present.sort((a, b) => a.v - b.v);
  const denominator = present.length - 1;
  let i = 0;
  while (i < present.length) {
    let j = i;
    while (j + 1 < present.length && present[j + 1]!.v === present[i]!.v) j += 1;
    // Average rank across the tied block, so equal values get an equal score.
    const p = (i + j) / 2 / denominator;
    for (let k = i; k <= j; k += 1) byId.set(present[k]!.id, p);
    i = j + 1;
  }
  return { byId, missing };
}

/** Ordinal position on one dimension, 1 = best. Null when the row has no value. */
function ordinals(rows: RankInput[], key: DimensionKey): Map<string, number> {
  const dim = DIMENSIONS[key]!;
  const present = rows
    .map((r) => ({ id: r.id, v: dim.value(r) }))
    .filter((x): x is { id: string; v: number } => x.v !== null && x.v !== undefined && Number.isFinite(x.v))
    .sort((a, b) => (dim.better === 'low' ? a.v - b.v : b.v - a.v));
  const out = new Map<string, number>();
  present.forEach((x, i) => out.set(x.id, i + 1));
  return out;
}

/**
 * True when `a` is at least as good as `b` everywhere and strictly better
 * somewhere. Rows missing a value on any dimension take part in neither side of
 * the comparison: absence of data is not evidence of quality.
 */
function dominates(a: (number | null)[], b: (number | null)[]): boolean {
  let strictlyBetter = false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === null || y === null) return false;
    if (x > y) return false;
    if (x < y) strictlyBetter = true;
  }
  return strictlyBetter;
}

/** Beyond this, "layer 12" tells a user nothing, so the rest are left unlabelled. */
const MAX_LAYERS = 6;

/**
 * Non-dominated sorting: layer 1 is the Pareto frontier, layer 2 is the
 * frontier of what remains, and so on.
 */
export function paretoLayers(rows: RankInput[], keys: DimensionKey[]): Map<string, number> {
  const layer = new Map<string, number>();
  if (keys.length < 2 || rows.length === 0) return layer;

  const vectors = new Map<string, (number | null)[]>();
  for (const r of rows) {
    vectors.set(
      r.id,
      keys.map((k) => {
        const dim = DIMENSIONS[k]!;
        const v = dim.value(r);
        if (v === null || v === undefined || !Number.isFinite(v)) return null;
        return dim.better === 'low' ? v : -v;
      }),
    );
  }

  // A row with any unknown dimension cannot be proven undominated, so it is not
  // placed on a layer at all rather than being placed on a flattering one.
  let remaining = rows.filter((r) => !vectors.get(r.id)!.includes(null));

  for (let n = 1; n <= MAX_LAYERS && remaining.length > 0; n += 1) {
    const front: RankInput[] = [];
    const rest: RankInput[] = [];
    for (const candidate of remaining) {
      const cv = vectors.get(candidate.id)!;
      const dominated = remaining.some((other) => other.id !== candidate.id && dominates(vectors.get(other.id)!, cv));
      (dominated ? rest : front).push(candidate);
    }
    for (const r of front) layer.set(r.id, n);
    // Nothing was dominated, so every remaining row shares this layer.
    if (rest.length === remaining.length) break;
    remaining = rest;
  }
  return layer;
}

export interface RankReason {
  key: DimensionKey;
  /** 1-based position on this dimension across the whole ranked set. */
  position: number | null;
  outOf: number;
  label: string;
}

export interface Ranked<T> {
  row: T;
  score: number;
  /** 1 means nothing in the set beats it on every requested dimension at once. */
  paretoLayer: number | null;
  reasons: RankReason[];
  /** Dimensions this row has no value for, so the UI can say the rank is partly blind. */
  unknown: DimensionKey[];
}

export interface RankResult<T> {
  ranked: Ranked<T>[];
  terms: SortTerm[];
  label: string;
  ignored: string[];
  /** How many rows are on the Pareto frontier. Zero when the sort is one-dimensional. */
  frontierSize: number;
}

/**
 * Ranks rows against a sort spec.
 *
 * `rows` must be the WHOLE candidate set, not a page of it. A percentile
 * computed over a page that was already truncated by a different ordering is a
 * percentile of the wrong population, and the answer would silently change with
 * the page size.
 */
export function rank<T extends RankInput>(rows: T[], spec: string | undefined): RankResult<T> {
  const { terms, label, ignored } = parseSortSpec(spec);
  const keys = terms.map((t) => t.key);
  const totalWeight = terms.reduce((s, t) => s + t.weight, 0);

  const pct = new Map<DimensionKey, ReturnType<typeof percentiles>>();
  const ord = new Map<DimensionKey, Map<string, number>>();
  for (const k of keys) {
    pct.set(k, percentiles(rows, k));
    ord.set(k, ordinals(rows, k));
  }
  const layers = paretoLayers(rows, keys);

  const ranked: Ranked<T>[] = rows.map((row) => {
    let score = 0;
    const unknown: DimensionKey[] = [];
    for (const t of terms) {
      const p = pct.get(t.key)!;
      score += (p.byId.get(row.id) ?? 1) * t.weight;
      if (p.missing.has(row.id)) unknown.push(t.key);
    }
    return {
      row,
      score: score / (totalWeight || 1),
      paretoLayer: layers.get(row.id) ?? null,
      unknown,
      reasons: keys.map((k) => ({
        key: k,
        position: ord.get(k)!.get(row.id) ?? null,
        outOf: ord.get(k)!.size,
        label: DIMENSIONS[k]!.superlative,
      })),
    };
  });

  /**
   * Frontier first, then score. A row on layer 1 is provably not beaten on
   * every axis at once, which is a stronger claim than any weighted score, so
   * it outranks a row that merely scored well on an arbitrary weighting.
   */
  ranked.sort((a, b) => {
    const la = a.paretoLayer ?? Number.MAX_SAFE_INTEGER;
    const lb = b.paretoLayer ?? Number.MAX_SAFE_INTEGER;
    if (la !== lb) return la - lb;
    if (a.score !== b.score) return a.score - b.score;
    return a.row.id.localeCompare(b.row.id);
  });

  return {
    ranked,
    terms,
    label,
    ignored,
    frontierSize: [...layers.values()].filter((n) => n === 1).length,
  };
}
