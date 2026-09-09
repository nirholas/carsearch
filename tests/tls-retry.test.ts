import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * A throttled refusal must be retried; a real one must not be retried forever.
 *
 * On several hosts a 403 is a rate limit wearing a refusal's clothes. Carvana
 * returned 403 for /cars/mercedes-benz and 200 with twenty-one cars for the
 * same URL a minute later, which sent a crawl hunting a wrong slug that was
 * never wrong. Treating every 403 as final loses whole makes at random.
 *
 * The behaviour needs a live host to exercise end to end, so what is guarded
 * here is the shape of the policy: bounded delays, and a 404 that still short
 * circuits, because a missing page will still be missing after a wait.
 */
const source = readFileSync(new URL('../src/transport/tls.ts', import.meta.url), 'utf8');

test('the retry schedule is bounded', () => {
  const match = source.match(/const RETRY_DELAYS_MS = \[([^\]]*)\]/);
  assert.ok(match, 'RETRY_DELAYS_MS must exist');
  const delays = match[1]!.split(',').map((d) => Number(d.trim())).filter((n) => Number.isFinite(n));
  assert.ok(delays.length > 0 && delays.length <= 4, 'a handful of retries, not an unbounded loop');
  assert.ok(delays.every((d) => d > 0 && d <= 30_000), 'no retry waits longer than half a minute');
  // Backoff, so a host under load is not hit at a fixed cadence.
  for (let i = 1; i < delays.length; i += 1) assert.ok(delays[i]! > delays[i - 1]!, 'delays must increase');
});

test('a 404 short circuits rather than being retried', () => {
  assert.match(source, /if \(res\.status === 404 \|\| res\.status === 410\) return result;/);
});

test('retry timers never hold the process open', () => {
  // A crawl that has finished must exit; an unref'd timer is how that is kept true.
  assert.match(source, /t\.unref\?\.\(\)/);
});

/**
 * A bare alias is not a fingerprint family.
 *
 * Hemmings was recorded as blocked to all three transports because `firefox`
 * got a 403. `firefox133` gets 200 and 692KB from the same URL, so the alias
 * resolves to a build old enough to be fingerprinted. Testing two aliases and
 * concluding "blocked" cost a real source, and the same reasoning would lose
 * the next one.
 */
test('the profile list covers distinct fingerprint families, not just aliases', () => {
  const match = source.match(/const PROFILES: TlsProfile\[\] = \[([^\]]*)\]/);
  assert.ok(match, 'PROFILES must exist');
  const profiles = match[1]!.split(',').map((p) => p.trim().replace(/'/g, '')).filter(Boolean);

  assert.ok(profiles.includes('firefox133'), 'the pinned Firefox that unblocked Hemmings must stay');
  assert.ok(profiles.some((p) => p.startsWith('chrome')), 'a Chrome family profile');
  assert.ok(profiles.some((p) => p.startsWith('okhttp')), 'a mobile family profile');
  // Coverage, not exhaustiveness: impit ships 22 versions and trying them all
  // turns one blocked host into a burst of requests at it.
  assert.ok(profiles.length >= 4 && profiles.length <= 8, `expected a curated handful, got ${profiles.length}`);
});

test('retries narrow to the likeliest profiles rather than replaying every one', () => {
  assert.match(
    source,
    /const retryOrder = order\.slice\(0, 2\)/,
    'a host that refused every profile instantly is refusing us, not throttling',
  );
  assert.match(source, /RETRY_DELAYS_MS\.flatMap\(\(d\) => \[d, \.\.\.retryOrder\]\)/);
});
