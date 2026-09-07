import type { Transport } from '../core/types.js';
import { browserText, evaluateInPage } from './browser.js';

/**
 * Two transports, not one.
 *
 * This is the load-bearing finding of the whole project. A plain HTTP request
 * and a real browser get completely different answers, in BOTH directions.
 * AutoTempest, CarMax and Bring a Trailer refuse a plain fetch and serve a
 * browser happily. Cars.com does the exact opposite: it answers a plain request
 * with 200 and shows headless Chromium a Cloudflare interstitial.
 *
 * A single-transport design silently loses whichever set it cannot reach, and
 * the failure looks like thin coverage rather than a bug. So every source
 * declares its transport, and anything declared 'either' falls back.
 */

const FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

export class BlockedError extends Error {
  constructor(
    public url: string,
    public status: number,
    public transport: Transport,
  ) {
    super(`${transport} transport blocked at ${url} (HTTP ${status})`);
    this.name = 'BlockedError';
  }
}

export async function plainFetch(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, {
    ...init,
    headers: { ...FETCH_HEADERS, ...(init.headers as Record<string, string> | undefined) },
    redirect: 'follow',
  });
  if (!res.ok) throw new BlockedError(url, res.status, 'fetch');
  return res.text();
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...FETCH_HEADERS, Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) throw new BlockedError(url, res.status, 'fetch');
  return (await res.json()) as T;
}

/**
 * Gets a page's text using the transport the source declares, falling back to
 * the other one when the declared transport is 'either' or when the preferred
 * transport fails outright.
 */
export async function fetchText(
  url: string,
  opts: { transport?: Transport; waitMs?: number } = {},
): Promise<string> {
  const transport = opts.transport ?? 'either';

  if (transport === 'blocked') {
    throw new BlockedError(url, 403, 'blocked');
  }
  if (transport === 'fetch') {
    return plainFetch(url);
  }
  if (transport === 'browser') {
    return browserText(url, { waitMs: opts.waitMs });
  }

  // 'either': try the cheap transport, fall back to the expensive one.
  try {
    return await plainFetch(url);
  } catch {
    return browserText(url, { waitMs: opts.waitMs });
  }
}

export { evaluateInPage };
