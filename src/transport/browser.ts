import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { EvaluateOptions } from '../core/types.js';
import { waitForTurn, recordChallenge, recordSuccess, CHALLENGE_PATTERN, ChallengedError } from './throttle.js';

/**
 * A single shared browser, because launching Chromium costs several seconds and
 * an aggregator makes hundreds of page visits per run.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
/**
 * The in-flight launch, memoized so concurrent callers share one browser.
 *
 * Caching the RESULT instead of the promise is a race: with sources crawling in
 * parallel, two adapters both saw a null context at startup, both called
 * chromium.launch(), and the second assignment orphaned the first browser. It
 * was never closed, so its process and stdio pipes kept the Node event loop
 * alive and the crawler hung after finishing all of its work, which reads as a
 * deadlock rather than a leak.
 */
let contextPromise: Promise<BrowserContext> | null = null;

async function getContext(): Promise<BrowserContext> {
  if (context) return context;
  if (contextPromise) return contextPromise;
  contextPromise = launchContext().finally(() => {
    contextPromise = null;
  });
  return contextPromise;
}

async function launchContext(): Promise<BrowserContext> {
  browser = await chromium.launch({
    args: ['--disable-blink-features=AutomationControlled'],
  });
  context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 1200 },
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  /**
   * Both init scripts are passed as raw strings rather than as functions.
   *
   * A function argument here is TypeScript, so esbuild compiles it, and esbuild
   * preserves function names by wrapping every named function in a
   * `__name(fn, "name")` call. When the script it produces is the very script
   * meant to DEFINE `__name`, it references the helper before creating it and
   * throws, so the shim silently fails to install and every extractor
   * containing a named inner function dies with "__name is not defined" inside
   * the page. A string is handed to the browser untouched and cannot be caught
   * by that circularity.
   */
  await context.addInitScript({
    content: `
      // navigator.webdriver is the single most commonly checked automation tell.
      Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });

      // esbuild's name-preservation helper, which does not travel with a
      // function serialized into the page by Playwright.
      if (typeof globalThis.__name !== 'function') {
        globalThis.__name = function (fn) { return fn; };
      }
    `,
  });

  return context;
}

/**
 * Retires the current session so the next request starts with fresh cookies.
 *
 * Deliberately does NOT close the context immediately. With sources crawling
 * concurrently, other adapters hold open pages in it, and closing it out from
 * under them destroys their pages mid-navigation. Those failures would surface
 * as unrelated sites appearing to block us, which is the most expensive kind of
 * false signal to chase.
 *
 * So the reference is dropped straight away (new pages get a clean context) and
 * the retired one is closed once its own pages have finished, with a cap so a
 * hung page cannot leak it forever.
 */
/**
 * Contexts retired by a challenge that are still draining.
 *
 * Tracked rather than forgotten so that shutdown can close them. The drain loop
 * used to be a detached async function nobody held a handle to, and its
 * one-second timers kept the Node event loop alive for up to a minute after the
 * crawl had finished and printed its results. Three challenge retries meant
 * three of those loops, and the symptom was a run that reported success in 88
 * seconds and then sat there until something killed it, which reads like a
 * hung crawl rather than a shutdown bug.
 */
const draining = new Set<BrowserContext>();

export async function resetContext(): Promise<void> {
  const retired = context;
  context = null;
  if (!retired) return;
  draining.add(retired);

  void (async () => {
    for (let i = 0; i < 60; i++) {
      if (!draining.has(retired) || retired.pages().length === 0) break;
      /**
       * unref so a pending drain never holds the process open. The wait is a
       * courtesy to pages still in flight, not a reason for the program to
       * outlive its own work.
       */
      await new Promise<void>((r) => {
        const t = setTimeout(r, 1000);
        t.unref?.();
      });
    }
    draining.delete(retired);
    await retired.close().catch(() => {});
  })();
}

export async function closeBrowser(): Promise<void> {
  // A launch that is still in flight must finish before we can close what it made.
  if (contextPromise) await contextPromise.catch(() => {});
  // Retired contexts first: their drain loops watch this set and stop early.
  const retired = [...draining];
  draining.clear();
  await Promise.all(retired.map((c) => c.close().catch(() => {})));
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  context = null;
  browser = null;
  contextPromise = null;
}

/**
 * Loads a URL in a real browser and runs `fn` in the page.
 *
 * `settleSelector` exists because results stream in per source asynchronously.
 * Polling until the count stops changing collects the slow sources; a fixed
 * wait silently truncates them, which looks like thin coverage rather than a
 * bug.
 */
export async function evaluateInPage<T>(url: string, fn: () => T, opts: EvaluateOptions = {}): Promise<T> {
  const maxAttempts = 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Pace per host, and give extra room to a host that just challenged us.
    await waitForTurn(url);
    try {
      const result = await evaluateOnce(url, fn, opts);
      recordSuccess(url);
      return result;
    } catch (e) {
      lastError = e as Error;
      // A missing page will still be missing after a session reset.
      if (e instanceof NotFoundError) throw e;
      if (!(e instanceof ChallengedError)) throw e;
      recordChallenge(url);
      /**
       * A challenge that does not clear on its own is a tainted session, not a
       * slow one. Cloudflare marks the visitor by cookie as well as by address,
       * so waiting longer in the same context just re-presents the same wall.
       * Dropping the context resets the half of that pair we control.
       */
      await resetContext();
    }
  }
  throw lastError ?? new Error(`failed to evaluate ${url}`);
}

export interface CapturedResponse {
  url: string;
  status: number;
  /** Parsed JSON body. Non-JSON responses are not captured. */
  body: unknown;
  bytes: number;
  /** The request body, for the POST search APIs where the query lives there. */
  request?: string;
  /** Request headers worth knowing about, such as an API key. */
  requestHeaders?: Record<string, string>;
}

/**
 * Loads a page and records the JSON its own frontend fetches.
 *
 * Most listing sites are now single-page apps: the HTML is a shell and the
 * inventory arrives over XHR. Scraping the rendered DOM of one of those is the
 * worst option available, because it reads a projection of the data through
 * hashed class names that change on the next deploy. The endpoint underneath is
 * the site's own contract with its own frontend, and it is both richer and far
 * more stable.
 *
 * This exists so finding that endpoint is a command rather than an afternoon
 * with devtools. Point it at a search page, read what comes back, and write the
 * adapter against the endpoint directly.
 */
/**
 * Headers every browser request carries, which say nothing about the endpoint.
 */
const BORING_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection',
  'content-length', 'content-type', 'host', 'origin', 'pragma', 'referer',
  'user-agent', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'sec-ch-ua',
  'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'priority', 'dnt', 'cookie',
]);

export async function captureJson(
  url: string,
  opts: EvaluateOptions & { minBytes?: number } = {},
): Promise<CapturedResponse[]> {
  const { waitMs = 6000, timeoutMs = 60_000, scroll = false, minBytes = 500 } = opts;
  const ctx = await getContext();
  const page = await ctx.newPage();
  const captured: CapturedResponse[] = [];

  page.on('response', (res) => {
    const type = res.headers()['content-type'] ?? '';
    if (!type.includes('json')) return;
    void res
      .text()
      .then((text) => {
        if (text.length < minBytes) return;
        try {
          captured.push({
            url: res.url(),
            status: res.status(),
            body: JSON.parse(text),
            bytes: text.length,
            /**
             * The request body, when there was one.
             *
             * A search API is almost always a POST, and the response alone does
             * not say what was asked for. Collecting Cars answers over Typesense
             * and the collection name, the queried fields and the filter syntax
             * exist only in the request; without them the endpoint is visible
             * and unusable.
             */
            request: res.request().postData() ?? undefined,
            /**
             * The request headers, minus the ones every request carries.
             *
             * An endpoint can be fully understood and still unusable: the Cars
             * Commerce listings API answers 401 "No API key found in request"
             * to a correctly shaped POST, because the key travels in a header
             * the response never mentions. The body says what was asked; the
             * headers say what was needed to ask it.
             */
            requestHeaders: Object.fromEntries(
              Object.entries(res.request().headers()).filter(([k]) => !BORING_HEADERS.has(k.toLowerCase())),
            ),
          });
        } catch {
          /* a content-type that lied; not worth reporting */
        }
      })
      .catch(() => {
        /* body already consumed or the request was aborted */
      });
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(waitMs);
    if (scroll) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);
    }
    return [...captured].sort((a, b) => b.bytes - a.bytes);
  } finally {
    await page.close().catch(() => {});
  }
}

/** The page is not there. Distinct from a block, and never worth retrying. */
export class NotFoundError extends Error {
  readonly notFound = true;
}

async function evaluateOnce<T>(url: string, fn: () => T, opts: EvaluateOptions = {}): Promise<T> {
  const {
    waitMs = 2000,
    settleSelector,
    stableChecks = 3,
    maxPolls = 14,
    expandSelector,
    maxExpands = 8,
    scroll = true,
    timeoutMs = 60000,
  } = opts;

  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    /**
     * A 404 is not a block, and conflating the two is expensive.
     *
     * Bring a Trailer files the G-Class under "gelandewagen", so the derived
     * URL 404s. The challenge detector saw a page with no listings and reported
     * "challenged", which sent the crawler through three session resets and a
     * ninety-second retry loop before announcing that a site we can reach
     * perfectly well was blocking us. Reading the status first turns that into
     * an immediate, accurate answer the caller can act on.
     */
    const status = response?.status() ?? 0;
    if (status === 404 || status === 410) {
      throw new NotFoundError(`${status} at ${url}`);
    }

    await page.waitForTimeout(waitMs);

    /**
     * A challenge page is a 200 with no data. Detecting it converts a silently
     * empty result into a loud, retryable failure, which is the difference
     * between "this model has no cars for sale" and "we asked too fast".
     *
     * Most interstitials are a JavaScript challenge that clears itself within a
     * few seconds once the browser has run it, so the first move is to wait
     * rather than to retry. Giving up at first sight of the banner throws away
     * a page that was about to load, and retrying immediately just earns
     * another challenge.
     */
    const isChallenged = () =>
      page.evaluate(
        (pattern: string) =>
          new RegExp(pattern, 'i').test(document.title + ' ' + (document.body?.innerText ?? '').slice(0, 1500)),
        CHALLENGE_PATTERN.source,
      );

    if (await isChallenged()) {
      let cleared = false;
      for (let i = 0; i < 10; i++) {
        await page.waitForTimeout(2500);
        if (!(await isChallenged())) {
          cleared = true;
          break;
        }
      }
      if (!cleared) throw new ChallengedError(url);
      // The challenge cost us the settle window, so give the real page its own.
      await page.waitForTimeout(waitMs);
    }

    if (expandSelector) {
      for (let i = 0; i < maxExpands; i++) {
        const btn = page.locator(expandSelector).first();
        if (!(await btn.count())) break;
        try {
          await btn.click({ timeout: 3000 });
          await page.waitForTimeout(2000);
        } catch {
          break;
        }
      }
    }

    if (settleSelector) {
      let last = -1;
      let stable = 0;
      for (let i = 0; i < maxPolls; i++) {
        await page.waitForTimeout(2200);
        if (scroll) await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        const n = await page.evaluate((sel) => document.querySelectorAll(sel).length, settleSelector);
        if (n === last) {
          if (++stable >= stableChecks) break;
        } else {
          stable = 0;
        }
        last = n;
      }
    } else if (scroll) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
    }

    return await page.evaluate(fn);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Fetches a URL's rendered HTML through a real browser. */
export async function browserText(url: string, opts: EvaluateOptions = {}): Promise<string> {
  return evaluateInPage(url, () => document.documentElement.outerHTML, opts);
}

/**
 * Reports whether a page looks like a bot wall rather than content. Used by the
 * prober so a green-to-red transition is visible before a run silently returns
 * nothing.
 */
export async function probe(url: string): Promise<{
  status: number | string;
  blocked: boolean;
  title: string;
  priceHits: number;
  jsonLd: number;
  textLength: number;
  error?: string;
}> {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500);
    const title = (await page.title()).slice(0, 60);
    const signal = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      return {
        blocked:
          /access denied|are you a human|unusual traffic|verify you are|pardon our interruption|blocked|captcha|cf-browser-verification/i.test(
            t,
          ),
        priceHits: (t.match(/\$\d{2},\d{3}/g) ?? []).length,
        jsonLd: document.querySelectorAll('script[type="application/ld+json"]').length,
        textLength: t.length,
      };
    });
    return { status: res ? res.status() : 'no-response', title, ...signal };
  } catch (e) {
    return {
      status: 'ERR',
      blocked: false,
      title: '',
      priceHits: 0,
      jsonLd: 0,
      textLength: 0,
      error: (e as Error).message.split('\n')[0]?.slice(0, 80),
    };
  } finally {
    await page.close().catch(() => {});
  }
}
