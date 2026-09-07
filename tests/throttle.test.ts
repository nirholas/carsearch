import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForTurn, recordSuccess } from '../src/transport/throttle.js';

/**
 * With sources crawling concurrently, two callers for the same host used to
 * read the same last-request time, sleep the same interval and then fire
 * simultaneously, defeating the throttle exactly when it mattered most.
 */
test('concurrent callers for one host are spaced, not bunched', async () => {
  const url = 'https://throttle-test.example/search';
  recordSuccess(url);
  const gap = 120;

  const started = Date.now();
  const times: number[] = [];
  await Promise.all(
    [0, 1, 2].map(async () => {
      await waitForTurn(url, gap);
      times.push(Date.now() - started);
    }),
  );

  times.sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) {
    const spacing = times[i]! - times[i - 1]!;
    assert.ok(spacing >= gap * 0.7, `requests ${i - 1} and ${i} were only ${spacing}ms apart, expected about ${gap}ms`);
  }
});

test('different hosts do not queue behind each other', async () => {
  const a = 'https://host-a.example/x';
  const b = 'https://host-b.example/x';
  recordSuccess(a);
  recordSuccess(b);
  const started = Date.now();
  await Promise.all([waitForTurn(a, 400), waitForTurn(b, 400)]);
  assert.ok(Date.now() - started < 200, 'a slow host must not hold up a fast one');
});
