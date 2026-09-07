import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { SearchQuery } from '../core/types.js';
import { loadVocabulary } from './vocabulary.js';

/**
 * Model-backed query parsing, for what the deterministic parser cannot reach.
 *
 * The regular-expression parser in parse.ts handles the shape most searches
 * take. This handles the rest: "something reliable for a long commute that
 * holds a car seat", "the cheapest way into a manual RWD coupe", "a truck that
 * can tow a boat but fits in a city garage". Those carry real constraints that
 * no pattern list will ever enumerate.
 *
 * It is deliberately the second pass, not the first. Most queries never reach
 * it, so the common path stays free and instant.
 */

const MODEL = 'claude-opus-5';

/** Mirrors SearchQuery. Everything is optional because a query constrains only what it mentions. */
const SearchQuerySchema = z.object({
  make: z.string().optional(),
  models: z.array(z.string()).optional(),
  yearMin: z.number().int().optional(),
  yearMax: z.number().int().optional(),
  priceMin: z.number().int().optional(),
  priceMax: z.number().int().optional(),
  mileageMax: z.number().int().optional(),
  bodyType: z.string().optional(),
  fuelType: z.string().optional(),
  zip: z.string().optional(),
  keywords: z.string().optional(),
  priceKinds: z.array(z.enum(['ask', 'bid', 'sold'])).optional(),
  interpretation: z.array(z.string()),
});

/** The same shape as JSON Schema, for the API's structured-output constraint. */
const JSON_SCHEMA = {
  type: 'object',
  properties: {
    make: { type: 'string' },
    models: { type: 'array', items: { type: 'string' } },
    yearMin: { type: 'integer' },
    yearMax: { type: 'integer' },
    priceMin: { type: 'integer' },
    priceMax: { type: 'integer' },
    mileageMax: { type: 'integer' },
    bodyType: { type: 'string' },
    fuelType: { type: 'string' },
    zip: { type: 'string' },
    keywords: { type: 'string' },
    priceKinds: { type: 'array', items: { type: 'string', enum: ['ask', 'bid', 'sold'] } },
    interpretation: {
      type: 'array',
      items: { type: 'string' },
      description: 'One short line per constraint you applied, written for the person who typed the query.',
    },
  },
  required: ['interpretation'],
  additionalProperties: false,
} as const;

function systemPrompt(): string {
  const vocab = loadVocabulary();
  const year = new Date().getFullYear();
  return [
    'You turn a car shopper\'s plain-English request into a structured search query.',
    '',
    `The current year is ${year}.`,
    '',
    'Rules:',
    '- Only fill a field the request actually constrains. Do not invent a budget, a year or a location that was not asked for.',
    '- Use catalogue names: "Mercedes-Benz", not "Merc"; "G-Class", not "G Wagon".',
    '- Prices are US dollars. Mileage is miles.',
    '- Set priceKinds to ["sold"] when the person is asking what something sold for or is worth, rather than what is for sale.',
    '- Translate vague requirements into concrete constraints and SAY SO in interpretation. If someone asks for a family car, that is a body style and a seat count, not a keyword.',
    '- Put anything you could not turn into a constraint into keywords rather than dropping it.',
    '- interpretation is shown back to the user, so each line must be short, plain and honest about any assumption you made.',
    '',
    `Known makes: ${vocab.makes.slice(0, 60).join(', ')}`,
  ].join('\n');
}

export function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
}

export interface LlmParseResult {
  query: SearchQuery;
  interpretation: string[];
}

/**
 * Parses a query with Claude. Returns null rather than throwing, because a
 * search box must never fail on the enrichment path: the deterministic parse is
 * always available and is what the caller falls back to.
 */
export async function parseWithClaude(text: string): Promise<LlmParseResult | null> {
  if (!hasCredentials()) return null;

  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: text }];

  const extract = (raw: string): LlmParseResult | null => {
    // The model may wrap JSON in prose or a code fence when structured output
    // is not in force, so take the outermost object rather than the whole body.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    const parsed = SearchQuerySchema.safeParse(JSON.parse(raw.slice(start, end + 1)));
    if (!parsed.success) return null;
    const { interpretation, ...query } = parsed.data;
    return { query: query as SearchQuery, interpretation };
  };

  const textOf = (res: Anthropic.Message): string =>
    res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      // Query parsing is a short extraction, not a reasoning problem. Low effort
      // keeps it fast and cheap without changing the answer.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', name: 'search_query', schema: JSON_SCHEMA },
      },
      system: systemPrompt(),
      messages,
    } as Anthropic.MessageCreateParamsNonStreaming);

    /**
     * A refusal on a used-car query would be extraordinary, but it is a real
     * stop reason and reading `content` without checking it is how a caller
     * ends up parsing an empty response. The deterministic parser is the
     * fallback, which is a stronger guarantee than a second model would be.
     */
    if (res.stop_reason === 'refusal') return null;
    return extract(textOf(res));
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return null;
    if (e instanceof Anthropic.RateLimitError) return null;

    /**
     * Structured output is the right tool here, but this path cannot be
     * exercised without live credentials, so a schema or parameter rejection
     * must not take the feature down. One retry without the constraint, asking
     * for JSON in the prompt instead, keeps the model parser working on any
     * SDK version that accepts the plain request shape.
     */
    if (e instanceof Anthropic.BadRequestError) {
      try {
        const res = await client.messages.create({
          model: MODEL,
          max_tokens: 2000,
          system: `${systemPrompt()}\n\nRespond with a single JSON object matching this schema and nothing else:\n${JSON.stringify(JSON_SCHEMA)}`,
          messages,
        });
        if (res.stop_reason === 'refusal') return null;
        return extract(textOf(res));
      } catch {
        return null;
      }
    }
    return null;
  }
}
