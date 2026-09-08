import { FACETS_BY_KEY, type FacetDef } from '../core/facets.js';

/**
 * Facet predicates, built once for both SQL dialects.
 *
 * The two backends differ only in how a parameter is spelled ($1 against ?), so
 * the caller passes a function that binds a value and returns its placeholder.
 * Everything else, including the unknown-value policy that is the whole
 * difficulty of facet search, is written once.
 */

export interface FacetFilter {
  /** Enum or text: match any of these. */
  in?: string[];
  /** Number: inclusive bounds. */
  min?: number;
  max?: number;
  /** Boolean. */
  is?: boolean;
  /**
   * Keep rows whose value is null.
   *
   * The default is the facet's own `strict` flag, and that default is the
   * single most consequential decision in this file. A buyer who filters for a
   * clean title must not be shown cars whose title nobody recorded; a buyer who
   * filters for four doors would rather see the ones that never published a
   * door count than lose two thirds of the market to a missing field.
   */
  includeUnknown?: boolean;
}

export type Bind = (value: unknown) => string;

export interface FacetPredicate {
  sql: string;
  facet: FacetDef;
  /** True when unknown-valued rows are being excluded, so the caller can say how many. */
  excludesUnknown: boolean;
}

export function buildFacetPredicates(
  facets: Record<string, FacetFilter> | undefined,
  bind: Bind,
): FacetPredicate[] {
  if (!facets) return [];
  const out: FacetPredicate[] = [];

  for (const [key, filter] of Object.entries(facets)) {
    const def = FACETS_BY_KEY.get(key);
    if (!def) continue;
    const col = def.column;
    const clauses: string[] = [];

    if (filter.in?.length) {
      const values = filter.in.filter((v) => v !== '' && v !== null && v !== undefined);
      if (values.length) {
        // LOWER on both sides: sources disagree on casing for colours and trims.
        clauses.push(`LOWER(${col}) IN (${values.map((v) => `LOWER(${bind(v)})`).join(', ')})`);
      }
    }
    if (filter.min !== undefined && Number.isFinite(filter.min)) clauses.push(`${col} >= ${bind(filter.min)}`);
    if (filter.max !== undefined && Number.isFinite(filter.max)) clauses.push(`${col} <= ${bind(filter.max)}`);
    if (filter.is !== undefined) {
      // Booleans are INTEGER in SQLite and BOOLEAN in Postgres; comparing to a
      // bound parameter lets each driver coerce rather than hardcoding TRUE/1.
      clauses.push(`${col} = ${bind(filter.is)}`);
    }

    if (clauses.length === 0) continue;
    const includeUnknown = filter.includeUnknown ?? !def.strict;
    const body = clauses.join(' AND ');
    out.push({
      facet: def,
      excludesUnknown: !includeUnknown,
      sql: includeUnknown ? `(${body} OR ${col} IS NULL)` : `(${body})`,
    });
  }
  return out;
}

/**
 * Reads facet filters out of a URL query string.
 *
 * The wire format is one parameter per constraint, named for the facet:
 *   `titleStatus=clean,rebuilt`     an enum or text, any of
 *   `owners.max=1`                  a numeric bound
 *   `certified=true`                a boolean
 *   `owners.unknown=1`              keep rows that never stated it
 *
 * Written this way so a search is a link a person can read, edit and share,
 * which a base64 blob or a POST body would not be.
 */
export function parseFacetQuery(
  query: Record<string, string>,
  /**
   * Parameters an endpoint uses for its own purpose and must not have read back
   * as a filter. `/api/market?mileage=45000` means "value a car at 45,000
   * miles", and without this it also filtered the whole market down to cars
   * whose odometer reads exactly 45,000, which returned no asking prices at all
   * while looking like an empty model rather than a bug.
   */
  reserved: readonly string[] = [],
): Record<string, FacetFilter> {
  const facets: Record<string, FacetFilter> = {};
  const skip = new Set(reserved);

  const ensure = (key: string): FacetFilter => (facets[key] ??= {});

  for (const [rawKey, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === '') continue;
    const [key = '', modifier] = rawKey.split('.');
    if (skip.has(key)) continue;
    const def = FACETS_BY_KEY.get(key);
    if (!def) continue;

    if (modifier === 'min' || modifier === 'max') {
      const n = Number(rawValue);
      if (Number.isFinite(n)) ensure(key)[modifier] = n;
      continue;
    }
    if (modifier === 'unknown') {
      ensure(key).includeUnknown = rawValue !== '0' && rawValue !== 'false';
      continue;
    }
    if (modifier) continue;

    if (def.kind === 'boolean') {
      if (rawValue === 'true' || rawValue === '1') ensure(key).is = true;
      else if (rawValue === 'false' || rawValue === '0') ensure(key).is = false;
      continue;
    }
    if (def.kind === 'number') {
      // A bare number on a numeric facet is an exact match, expressed as a
      // degenerate range so there is only one code path downstream.
      const n = Number(rawValue);
      if (Number.isFinite(n)) { ensure(key).min = n; ensure(key).max = n; }
      continue;
    }
    ensure(key).in = rawValue.split(',').map((v) => v.trim()).filter(Boolean);
  }

  return facets;
}
