import { chromium } from 'playwright';

/**
 * Loads the running UI in a real browser, records any console error, and
 * captures the result. A page that returns HTTP 200 can still be blank or
 * throwing on every render, so "the server answered" is not evidence the site
 * works.
 */
const base = process.env.UI_URL ?? 'http://localhost:8791';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } } as never);

const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const failedRequests: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));

await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2500);

const state = await page.evaluate(() => ({
  cards: document.querySelectorAll('.card').length,
  summary: (document.querySelector('#summary') as HTMLElement | null)?.innerText.trim() ?? '',
  comps: (document.querySelector('#comps-strip') as HTMLElement | null)?.innerText.replace(/\n+/g, ' | ').trim() ?? '',
  understood: (document.querySelector('#understood') as HTMLElement | null)?.innerText.replace(/\n+/g, ' | ').trim() ?? '',
  emptyState: document.querySelector('.state h3')?.textContent ?? '',
}));

await page.screenshot({ path: 'data/ui-listings.png', fullPage: false });

// Now exercise the plain-English box, which is the part most likely to be broken.
await page.fill('#q', 'what did a 2017 macan sell for');
await page.press('#q', 'Enter');
await page.waitForTimeout(3500);
const asked = await page.evaluate(() => ({
  cards: document.querySelectorAll('.card').length,
  understood: (document.querySelector('#understood') as HTMLElement | null)?.innerText.replace(/\n+/g, ' | ').trim() ?? '',
  firstCard: (document.querySelector('.card') as HTMLElement | null)?.innerText.replace(/\n+/g, ' | ').slice(0, 160) ?? '',
}));
await page.screenshot({ path: 'data/ui-ask.png', fullPage: false });

console.log('--- initial load');
console.log('cards      ', state.cards);
console.log('summary    ', state.summary);
console.log('comps strip', state.comps.slice(0, 220));
console.log('empty state', state.emptyState);
console.log('--- after asking "what did a 2017 macan sell for"');
console.log('cards      ', asked.cards);
console.log('understood ', asked.understood);
console.log('first card ', asked.firstCard);
console.log('--- errors');
console.log('console errors :', consoleErrors.length, consoleErrors.slice(0, 4));
console.log('page errors    :', pageErrors.length, pageErrors.slice(0, 4));
console.log('failed requests:', failedRequests.length, failedRequests.slice(0, 4));

await browser.close();
