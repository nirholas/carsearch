/**
 * Reading data out of a Next.js App Router page.
 *
 * Modern React sites do not ship their data as one JSON blob any more. The App
 * Router streams it as a sequence of `self.__next_f.push([1, "..."])` calls,
 * each carrying a fragment of an escaped React Flight payload. Concatenating
 * the fragments and unescaping them recovers the same objects the server used
 * to render the page.
 *
 * Worth having as a shared reader rather than per adapter, because it is the
 * default shape of any recently rebuilt listings site, and the alternative is
 * scraping a rendered DOM whose class names are hashed per build.
 */

const PUSH = /self\.__next_f\.push\(\s*\[\s*1\s*,\s*(".*?")\s*\]\s*\)/gs;

/** The concatenated flight payload, or an empty string when the page is not one. */
export function nextFlightText(html: string): string {
  let out = '';
  for (const m of html.matchAll(PUSH)) {
    try {
      // Each fragment is a JSON string literal, so JSON.parse does the
      // unescaping correctly, including the \u sequences a regex would mangle.
      out += JSON.parse(m[1]!) as string;
    } catch {
      /* a fragment split mid-escape; the rest still parses */
    }
  }
  return out;
}

/**
 * Every balanced JSON object or array in a string, from the given start.
 *
 * The flight payload is not itself valid JSON: it is line-prefixed fragments
 * with embedded objects. Scanning for balanced brackets, respecting strings and
 * escapes, is the only reliable way to lift the objects back out.
 */
function* balanced(text: string, from = 0): Generator<string> {
  for (let i = from; i < text.length; i += 1) {
    const open = text[i];
    if (open !== '{' && open !== '[') continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let j = i; j < text.length; j += 1) {
      const c = text[j]!;
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          yield text.slice(i, j + 1);
          i = j;
          break;
        }
      }
    }
  }
}

/**
 * Finds arrays of records that look like the page's real data.
 *
 * `marker` is a field name every record carries, which is how an inventory list
 * is told apart from the dozens of config and analytics objects in the same
 * payload.
 */
export function findRecordArrays<T = Record<string, unknown>>(
  html: string,
  marker: string,
  minLength = 3,
): T[][] {
  const text = nextFlightText(html);
  if (!text) return [];

  const found: T[][] = [];
  const seen = new Set<string>();

  // Only scan near a marker occurrence; the payload is megabytes and a full
  // bracket scan of all of it is quadratic for no benefit.
  const needle = `"${marker}"`;
  let at = text.indexOf(needle);
  while (at !== -1) {
    const window = text.slice(Math.max(0, at - 200_000), at + 200_000);
    for (const candidate of balanced(window)) {
      if (candidate.length < 40 || !candidate.startsWith('[')) continue;
      if (!candidate.includes(needle)) continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (!Array.isArray(parsed) || parsed.length < minLength) continue;
        if (!parsed.every((x) => x && typeof x === 'object' && marker in (x as object))) continue;
        found.push(parsed as T[]);
      } catch {
        /* not a complete object at this offset */
      }
    }
    at = text.indexOf(needle, at + needle.length);
    if (found.length) break;
  }

  return found.sort((a, b) => b.length - a.length);
}

/**
 * Individual records carrying a marker field, wherever they sit.
 *
 * `findRecordArrays` requires the records to live in one contiguous array, and
 * a streamed flight payload often does not give you that: the array may be
 * split across fragments, or the records may hang off a keyed object. Carvana's
 * page carries twenty-one vehicles that the array scan could not see for
 * exactly that reason.
 *
 * This scans for objects instead, which makes no assumption about how they are
 * grouped. Nested duplicates are dropped by preferring the outermost object
 * that contains each marker occurrence.
 */
export function findRecords<T = Record<string, unknown>>(html: string, marker: string): T[] {
  const text = nextFlightText(html) || html;
  const needle = `"${marker}"`;
  const out: T[] = [];
  const seen = new Set<string>();

  let at = text.indexOf(needle);
  while (at !== -1) {
    /**
     * Walk backwards to the opening brace of the object this field belongs to,
     * tracking nesting so a `{` inside a sibling object is not mistaken for it.
     */
    let depth = 0;
    let start = -1;
    for (let i = at; i >= 0 && at - i < 200_000; i -= 1) {
      const c = text[i];
      if (c === '}') depth += 1;
      else if (c === '{') {
        if (depth === 0) { start = i; break; }
        depth -= 1;
      }
    }

    if (start >= 0) {
      for (const candidate of balanced(text, start)) {
        if (!candidate.startsWith('{')) break;
        try {
          const parsed = JSON.parse(candidate) as Record<string, unknown>;
          if (marker in parsed && !seen.has(candidate)) {
            seen.add(candidate);
            out.push(parsed as T);
          }
        } catch {
          /* the object straddles a fragment boundary and cannot be recovered */
        }
        break;
      }
    }
    at = text.indexOf(needle, at + needle.length);
  }
  return out;
}
