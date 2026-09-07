import type { SearchQuery } from '../core/types.js';
import { parseQuery, type ParsedQuery } from './parse.js';
import { parseWithClaude, hasCredentials } from './llm.js';

/**
 * The natural-language entry point.
 *
 * Deterministic first, always. The model is consulted only when the pattern
 * parser came back with nothing, or when it understood the query but left a
 * meaningful chunk of it unexplained. That keeps the ordinary case free and
 * instant, and spends a round trip only where it buys something.
 */

export interface AskResult {
  query: SearchQuery;
  interpretation: string[];
  /** Which parser produced the result, so the UI and the logs can tell them apart. */
  parser: 'deterministic' | 'claude' | 'deterministic (claude unavailable)';
  original: string;
}

/** Leftover text longer than this suggests the pattern parser missed a real constraint. */
const LEFTOVER_ESCALATION_CHARS = 12;

export async function ask(text: string): Promise<AskResult> {
  const local: ParsedQuery = parseQuery(text);
  const needsHelp = !local.confident || local.leftover.length > LEFTOVER_ESCALATION_CHARS;

  if (!needsHelp) {
    return { query: local.query, interpretation: local.interpretation, parser: 'deterministic', original: text };
  }

  if (!hasCredentials()) {
    return {
      query: local.query,
      interpretation: local.confident
        ? local.interpretation
        : ['Could not read that as a search. Try naming a make, a model or a budget.'],
      parser: 'deterministic (claude unavailable)',
      original: text,
    };
  }

  const remote = await parseWithClaude(text);
  if (!remote) {
    return {
      query: local.query,
      interpretation: local.interpretation,
      parser: 'deterministic (claude unavailable)',
      original: text,
    };
  }

  /**
   * The deterministic parse wins on any field it filled. It read the literal
   * text, so where the two disagree on an explicit number the regex is the one
   * quoting the user rather than interpreting them.
   */
  return {
    query: { ...remote.query, ...local.query },
    interpretation: [...local.interpretation, ...remote.interpretation],
    parser: 'claude',
    original: text,
  };
}

export { parseQuery, hasCredentials };
