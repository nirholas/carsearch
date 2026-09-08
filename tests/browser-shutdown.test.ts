import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetContext, closeBrowser, evaluateInPage } from '../src/transport/browser.js';

/**
 * A crawl that finished must exit.
 *
 * The drain loop that waits for a retired context's pages used to be detached,
 * with one-second timers nobody held a handle to. Those timers kept Node alive
 * for up to a minute after the run had printed its results, and three challenge
 * retries meant three of them. From the outside that is indistinguishable from
 * a hung crawler, which is exactly how it was first misdiagnosed.
 */
test('a challenge-retired context does not outlive the run', async () => {
  // A real context, so the drain path is the one under test.
  await evaluateInPage('data:text/html,<p>one</p>', () => document.title, { waitMs: 50 });

  await resetContext();
  await resetContext();
  await resetContext();

  const started = Date.now();
  await closeBrowser();
  const elapsed = Date.now() - started;

  // Shutdown must not wait out the 60-second courtesy drain.
  assert.ok(elapsed < 20_000, `closeBrowser took ${elapsed}ms, which means it waited on a drain loop`);

  // Nothing timer-shaped may be left holding the loop open.
  const held = process.getActiveResourcesInfo().filter((r) => r === 'Timeout');
  assert.deepEqual(held, [], 'a pending drain timer is still keeping the process alive');
});
