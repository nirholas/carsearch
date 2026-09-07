import { chromium } from 'playwright';

/**
 * Loads the UI in a real browser and captures each view, recording console
 * errors, page errors and failed requests. A page that returns HTTP 200 can
 * still be blank or throwing on every render, so a status code is not evidence.
 */
const base = process.env.UI_URL ?? 'http://localhost:8793';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 1000 });

const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
page.on('requestfailed', (r) => {
  // Third-party listing photos can 404 without the page being broken.
  if (!r.url().startsWith(base)) return;
  errors.push(`request: ${r.url()} ${r.failure()?.errorText}`);
});

const text = (sel: string) =>
  page.evaluate((s) => (document.querySelector(s) as HTMLElement | null)?.innerText.replace(/\n+/g, ' | ').trim() ?? '', sel);

await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: 'data/ui-1-home.png' });
console.log('home    h1:', await text('.hero h1'), '| chips:', await page.locator('.source-chip').count());

await page.fill('#hero-q', 'porsche macan under 40k');
await page.press('#hero-q', 'Enter');
await page.waitForTimeout(3000);
await page.screenshot({ path: 'data/ui-2-results.png' });
console.log('results cards:', await page.locator('.card').count(),
  '| source tabs:', await page.locator('.source-tab').count(),
  '| deal badges:', await page.locator('.deal').count());
console.log('        comps:', (await text('#comps-strip')).slice(0, 190));

const tabs = page.locator('.source-tab');
if ((await tabs.count()) > 1) {
  await tabs.nth(1).click();
  await page.waitForTimeout(600);
  console.log('        after source tab click, cards:', await page.locator('.card').count());
  await tabs.nth(0).click();
  await page.waitForTimeout(400);
}

await page.click('[data-route="auctions"]');
await page.waitForTimeout(2500);
await page.screenshot({ path: 'data/ui-3-auctions.png' });
console.log('auction cards:', await page.locator('.acard').count(), '|', (await text('#auction-summary')).slice(0, 150));

await page.click('[data-route="sources"]');
await page.waitForTimeout(1800);
await page.screenshot({ path: 'data/ui-4-sources.png' });
console.log('sources rows:', await page.locator('tbody tr').count());

await page.setViewportSize({ width: 390, height: 844 });
await page.click('[data-route="results"]');
await page.waitForTimeout(800);
await page.screenshot({ path: 'data/ui-5-mobile.png' });
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
console.log('mobile 390px horizontal overflow:', overflow);

console.log(errors.length === 0 ? 'NO ERRORS' : `ERRORS (${errors.length}): ${errors.slice(0, 6).join(' ;; ')}`);
await browser.close();
