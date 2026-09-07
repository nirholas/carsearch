import { evaluateInPage, closeBrowser } from '../src/transport/browser.js';

const url =
  'https://www.cars.com/shopping/results/?stock_type=used&makes[]=porsche&maximum_distance=all&zip=92101&list_price_max=40000&sort=mileage';

const out = await evaluateInPage(
  url,
  () => {
    const tags: Record<string, number> = {};
    for (const el of document.querySelectorAll('*')) {
      const t = el.tagName.toLowerCase();
      if (t.includes('-')) tags[t] = (tags[t] ?? 0) + 1;
    }
    // Find elements whose own text is a price, then describe their ancestry.
    const priceEls = [...document.querySelectorAll('*')].filter((el) => {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('');
      return /^\s*\$\d{1,3}(,\d{3})+\s*$/.test(own);
    });
    const sample = priceEls[0];
    const chain: string[] = [];
    let cur: Element | null = sample ?? null;
    for (let i = 0; cur && i < 6; i++) {
      chain.push(`${cur.tagName.toLowerCase()}.${(cur.className || '').toString().split(/\s+/).slice(0, 3).join('.')}`);
      cur = cur.parentElement;
    }
    const card = sample?.closest('[data-listing-id], [id^="vehicle"], article, li');
    return {
      customTags: tags,
      priceElCount: priceEls.length,
      chain,
      cardTag: card ? card.tagName.toLowerCase() + '.' + (card.className || '').toString().slice(0, 90) : null,
      cardHtml: card ? card.outerHTML.slice(0, 1600) : null,
      bodyLen: document.body.innerText.length,
    };
  },
  { waitMs: 9000, scroll: true, settleSelector: 'a[href*="/vehicledetail/"]', stableChecks: 2, maxPolls: 6 },
);

console.log('custom tags:', JSON.stringify(Object.entries(out.customTags).slice(0, 18)));
console.log('price elements:', out.priceElCount, ' body text len:', out.bodyLen);
console.log('ancestor chain:', out.chain.join('  <  '));
console.log('card:', out.cardTag);
console.log('\nCARD HTML:\n', out.cardHtml);
await closeBrowser();
