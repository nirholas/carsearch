import type { Impit as ImpitType, ImpitOptions } from 'impit';

/**
 * The third transport: a plain HTTP request wearing a browser's TLS handshake.
 *
 * The registry was built on a two-transport test, plain fetch against a real
 * Chromium, and ten sources were recorded as blocked on the strength of it.
 * That test had a hole. Several CDNs fingerprint the TLS ClientHello itself
 * (JA3), and Node's handshake does not look like any browser's, so they refuse
 * the request before a single header is read. A real Chromium passes that check
 * but fails others, which is why the two transports disagreed in both
 * directions and neither predicted the other.
 *
 * Measured on 2026-09-08, this transport is the only one that reaches Carvana
 * (403 to fetch, 200 and 1.2MB here), PCARMARKET and Collecting Cars. It is
 * also far cheaper than a browser: no page, no renderer, no memory.
 *
 * It is not a universal key. Hemmings, AutoNation, Edmunds, EchoPark, TrueCar
 * and Carsforsale still refuse every profile available here. Those stay
 * recorded as blocked, with the profiles that were tried, so nobody re-runs the
 * same experiment.
 */

/**
 * impit is loaded on first use, never at import time.
 *
 * It is a native module, and its platform binding ships as an OPTIONAL npm
 * dependency. The production web image installs with `--omit=optional` on
 * purpose, because that is what keeps better-sqlite3 (the only other native
 * module) out of a container that must never touch a local database. A
 * top-level import therefore crashed the web server at startup on a transport
 * it has no use for: serving a search reads Postgres, it does not crawl.
 *
 * Loading it lazily means the web image needs no native binding at all, and the
 * crawler image, which does crawl, pays for it the first time it asks.
 */
type ImpitCtor = new (opts: Partial<ImpitOptions>) => ImpitType;
let impitCtor: Promise<ImpitCtor> | null = null;

async function loadImpit(): Promise<ImpitCtor> {
  impitCtor ??= import('impit').then((m) => m.Impit as unknown as ImpitCtor);
  return impitCtor;
}

/** True when this process can use the TLS transport at all. */
export async function tlsAvailable(): Promise<boolean> {
  try {
    await loadImpit();
    return true;
  } catch {
    return false;
  }
}

export type TlsProfile = 'chrome' | 'firefox';

/** Profiles to try, in order. The winner per host is remembered for the run. */
const PROFILES: TlsProfile[] = ['chrome', 'firefox'];

const winners = new Map<string, TlsProfile>();

/**
 * How long to wait before retrying a refusal.
 *
 * On several of these hosts a 403 is a rate limit wearing a refusal's clothes.
 * Carvana returned 403 for /cars/mercedes-benz and 200 with twenty-one cars for
 * the same URL a minute later, which sent a crawl looking for a wrong slug that
 * was never wrong. A refusal that clears on its own is not a refusal, and
 * treating every 403 as final loses whole makes at random.
 */
const RETRY_DELAYS_MS = [1500, 5000];

const sleep = (ms: number) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  t.unref?.();
});

async function clientFor(profile: TlsProfile, opts: Partial<ImpitOptions> = {}): Promise<ImpitType> {
  const Impit = await loadImpit();
  return new Impit({
    browser: profile,
    // Some of these hosts serve an intermediate chain Node rejects while every
    // real browser accepts it. The alternative to this flag is losing the
    // source, and nothing secret is being sent to a public listings page.
    ignoreTlsErrors: true,
    followRedirects: true,
    timeout: 30_000,
    ...opts,
  });
}

export interface TlsResponse {
  status: number;
  body: string;
  profile: TlsProfile;
  url: string;
}

/**
 * Per-request options, kept separate from the client options.
 *
 * Conflating the two was a real bug: the second argument went to the Impit
 * CONSTRUCTOR, where `method` and `body` mean nothing, so every request was a
 * GET however it was written. Copart's search endpoint answered 405 and read
 * like a wrong path rather than a wrong verb.
 */
export interface TlsRequest {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Fetches a URL, trying each impersonation profile until one is accepted.
 *
 * The winning profile is per host, not global: carbide's field notes found
 * Chrome opens one site while its neighbours want Safari, and a single
 * hardcoded profile loses half the sources. The winner is cached so the second
 * request to a host pays nothing for the search.
 */
export async function fetchWithTls(
  url: string,
  request: TlsRequest = {},
  clientOpts: Partial<ImpitOptions> = {},
): Promise<TlsResponse> {
  const host = new URL(url).hostname;
  const known = winners.get(host);
  const order = known ? [known, ...PROFILES.filter((p) => p !== known)] : PROFILES;

  let last: TlsResponse | null = null;
  let lastError: Error | null = null;

  // Each profile, then each profile again after a pause. A host that refuses
  // both profiles instantly is refusing us; one that clears after a wait was
  // throttling.
  const attempts: (TlsProfile | number)[] = [...order, ...RETRY_DELAYS_MS.flatMap((d) => [d, ...order])];

  for (const step of attempts) {
    if (typeof step === 'number') {
      await sleep(step);
      continue;
    }
    const profile = step;
    try {
      const client = await clientFor(profile, clientOpts);
      const res = await client.fetch(url, {
        method: request.method ?? 'GET',
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.headers === undefined ? {} : { headers: request.headers }),
      } as never);
      const body = await res.text();
      const result: TlsResponse = { status: res.status, body, profile, url };
      if (res.status >= 200 && res.status < 300) {
        winners.set(host, profile);
        return result;
      }
      /**
       * A 404 is an answer, not a refusal. Retrying it under another profile
       * wastes a request and, worse, invites the rate limiter that turns a
       * simple wrong URL into an apparent block.
       */
      if (res.status === 404 || res.status === 410) return result;
      last = result;
    } catch (e) {
      lastError = e as Error;
    }
  }

  if (last) return last;
  throw lastError ?? new Error(`no TLS profile could reach ${url}`);
}

/** Which profile currently works for a host, for the prober's report. */
export function winningProfile(host: string): TlsProfile | null {
  return winners.get(host) ?? null;
}

export function resetTlsProfiles(): void {
  winners.clear();
}
