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

async function getContext(): Promise<BrowserContext> {
  if (context) return context;
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

export async function closeBrowser(): Promise<void> {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  context = null;
  browser = null;
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
      if (!(e instanceof ChallengedError)) throw e;
      recordChallenge(url);
    }
  }
  throw lastError ?? new Error(`failed to evaluate ${url}`);
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
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
