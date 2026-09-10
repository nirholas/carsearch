import { evaluateInPage, closeBrowser } from '../src/transport/browser.js';

/**
 * Opens one listing page and reports what it says about the car's history.
 *
 * Search results carry only what a source chooses to put on a results page,
 * and for most sites that is nothing about the title. The cheapest car in a
 * ranking is exactly the one whose silence matters most, so this reads the
 * detail page for the VIN and the history language rather than leaving the
 * buyer to assume.
 */

const url = process.argv[2];
if (!url) throw new Error('usage: inspect-listing.ts <listing url>');

const HISTORY = [
  'salvage', 'rebuilt', 'flood', 'lemon', 'junk', 'branded', 'frame damage',
  'accident', 'accidents reported', 'no accidents', 'clean title', 'title',
  'owner', 'owners', 'theft', 'odometer',
];

const found = await evaluateInPage(
  url,
  () => {
    const text = document.body.innerText ?? '';
    const vin = text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/)?.[0] ?? null;
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.length < 200);
    return { vin, title: document.title, lines };
  },
  { waitMs: 6000 },
);

const relevant = found.lines.filter((l) => HISTORY.some((k) => l.toLowerCase().includes(k)));
console.log(`title: ${found.title}`);
console.log(`vin:   ${found.vin ?? 'not published on the page'}`);
console.log(relevant.length ? 'history language on the page:' : 'the page says nothing about history');
for (const l of [...new Set(relevant)].slice(0, 25)) console.log(`  ${l}`);

await closeBrowser();
