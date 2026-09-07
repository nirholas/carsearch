import { evaluateInPage, closeBrowser } from '../src/transport/browser.js';

/** Counts real result cards for each candidate model-slug format instead of guessing. */
const candidates = ['porsche-911', '911', 'porsche-cayman', 'porsche-718_cayman', 'porsche-macan'];

for (const slug of candidates) {
  const url = `https://www.cars.com/shopping/results/?stock_type=used&makes[]=porsche&models[]=${slug}&maximum_distance=all&zip=92101&page_size=100`;
  try {
    const r = await evaluateInPage(
      url,
      () => ({
        cards: document.querySelectorAll('fuse-card[data-vehicle-details]').length,
        title: document.title,
        noResults: /no (matches|results)|0 matches/i.test(document.body.innerText.slice(0, 3000)),
      }),
      { waitMs: 6000, settleSelector: 'fuse-card[data-vehicle-details]', stableChecks: 2, maxPolls: 4 },
    );
    console.log(`${slug.padEnd(22)} cards=${String(r.cards).padStart(3)} noResults=${r.noResults}  ${r.title.slice(0, 60)}`);
  } catch (e) {
    console.log(`${slug.padEnd(22)} FAILED ${(e as Error).message.split('\n')[0]}`);
  }
}
await closeBrowser();
