import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInPage, closeBrowser } from '../src/transport/browser.js';

/**
 * Regression test for the esbuild `__name` helper.
 *
 * An extractor containing a named inner function used to throw "__name is not
 * defined" inside the page while an otherwise identical extractor without one
 * worked. The failure surfaced as specific sources appearing to block us, which
 * is the most expensive kind of bug to chase. This asserts the shim is in place.
 */
test('an extractor with named inner functions runs inside the page', async () => {
  const result = await evaluateInPage(
    'data:text/html,<div class="x">7</div><div class="x">8</div>',
    () => {
      const read = (el: Element): number => Number(el.textContent);
      const double = (n: number): number => n * 2;
      return [...document.querySelectorAll('.x')].map(read).map(double);
    },
    { waitMs: 100, scroll: false },
  );
  assert.deepEqual(result, [14, 16]);
  await closeBrowser();
});
