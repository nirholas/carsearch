import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateInPage, closeBrowser } from '../src/transport/browser.js';

/**
 * Regression test for the concurrent-launch race.
 *
 * Caching the browser RESULT rather than the in-flight promise meant two
 * adapters starting at the same moment both saw a null context, both launched
 * Chromium, and the second assignment orphaned the first browser. Nothing
 * failed and no results were lost: the crawl finished correctly and then the
 * process hung forever, because the orphan's process handle held the event loop
 * open. It presented as a deadlock, which is why it cost so long to find.
 *
 * The assertion is on the symptom that actually mattered, a leaked child
 * process, not on the internal that caused it.
 */
test('concurrent page requests share one browser and leave no orphan process', async () => {
  const results = await Promise.all(
    [1, 2, 3, 4].map((n) =>
      evaluateInPage(
        `data:text/html,<div id="n">${n}</div>`,
        () => Number(document.querySelector('#n')?.textContent),
        { waitMs: 100, scroll: false },
      ),
    ),
  );
  assert.deepEqual(results.sort(), [1, 2, 3, 4]);

  await closeBrowser();

  // Give the runtime a beat to reap the closed browser's handles.
  await new Promise((r) => setTimeout(r, 500));
  const held = process.getActiveResourcesInfo();
  assert.equal(
    held.filter((h) => h === 'ProcessWrap').length,
    0,
    `a browser process survived closeBrowser(): ${JSON.stringify(held)}`,
  );
});
