import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listingLinks, metrosFor, REGION_METROS } from '../src/sources/craigslist.js';

/**
 * The listing link and the region list both decide whether a buyer can act on
 * a Craigslist result at all.
 */

test('a result links to the listing, not to a search for its title', () => {
  // The ItemList carries no per-item link, and a search for the title sends the
  // buyer to a page that may no longer contain the truck.
  const html = `
    <li class="cl-static-search-result" title="1999 Suzuki Carry Kei Truck | 53,750 Miles">
      <a href="https://www.craigslist.org/view/d/westlake-village-1999-suzuki-carry-kei/xkAWNG2VXssnuC2DW59DZT">x</a>
    </li>
    <li class="cl-static-search-result" title="Honda Acty &amp; trailer">
      <a href="https://www.craigslist.org/view/d/la-honda-acty/AbCdEfGhIjKl">y</a>
    </li>`;
  const links = listingLinks(html);
  assert.equal(
    links.get('1999 Suzuki Carry Kei Truck | 53,750 Miles')?.[0],
    'https://www.craigslist.org/view/d/westlake-village-1999-suzuki-carry-kei/xkAWNG2VXssnuC2DW59DZT',
  );
  // Titles arrive HTML-escaped in the attribute and unescaped in the JSON-LD.
  assert.ok(links.has('Honda Acty & trailer'));
});

test('a repeated title keeps every link, in order', () => {
  const li = (href: string) => `<li class="cl-static-search-result" title="Kei truck"><a href="${href}">x</a></li>`;
  const links = listingLinks(li('https://a.example/one1234567') + li('https://a.example/two1234567'));
  assert.deepEqual(links.get('Kei truck'), ['https://a.example/one1234567', 'https://a.example/two1234567']);
});

test('a state expands to every Craigslist site in it', () => {
  // The national default reaches exactly two California sites.
  assert.equal(metrosFor(['CA']).length, REGION_METROS.CA!.length);
  assert.ok(metrosFor(['ca']).includes('chico'));
  // A subdomain passes straight through, and the default is unchanged.
  assert.deepEqual(metrosFor(['reno']), ['reno']);
  assert.equal(metrosFor(undefined).length, 8);
});
