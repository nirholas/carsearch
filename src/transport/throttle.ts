/**
 * Per-host politeness and challenge backoff.
 *
 * Discovered the hard way: Cars.com serves a correct, full result page for the
 * first request and a Cloudflare "Attention Required!" challenge for the next
 * three when they arrive back to back. Every one of those returned HTTP 200
 * with zero cards, so the run looked like a market with no matching cars rather
 * than a source refusing to talk to us. A crawler that does not pace itself
 * does not fail loudly, it fails quietly and wrong.
 *
 * Two mechanisms, both per host rather than global, so a slow site never holds
 * up a fast one:
 *
 *   1. A minimum gap between requests, always enforced.
 *   2. Exponential backoff when a response comes back as a challenge, because
 *      the correct response to being asked to slow down is to slow down.
 */

const DEFAULT_GAP_MS = 3000;
const lastRequestAt = new Map<string, number>();
const consecutiveChallenges = new Map<string, number>();

/** Text that means "we noticed you are a robot" rather than "here are your results". */
export const CHALLENGE_PATTERN =
  /attention required|access denied|are you a human|unusual traffic|verify you are|pardon our interruption|checking your browser|just a moment|cf-browser-verification|captcha/i;

export class ChallengedError extends Error {
  constructor(public url: string) {
    super(`challenged at ${url}`);
    this.name = 'ChallengedError';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until this host is allowed another request, then reserves the slot. */
export async function waitForTurn(url: string, gapMs = DEFAULT_GAP_MS): Promise<void> {
  const host = hostOf(url);
  const now = Date.now();
  const last = lastRequestAt.get(host) ?? 0;

  // A host that has just challenged us gets progressively more room.
  const strikes = consecutiveChallenges.get(host) ?? 0;
  const penalty = strikes === 0 ? 0 : Math.min(60000, gapMs * 2 ** strikes);

  const readyAt = last + gapMs + penalty;
  if (readyAt > now) await sleep(readyAt - now);
  lastRequestAt.set(hostOf(url), Date.now());
}

export function recordChallenge(url: string): number {
  const host = hostOf(url);
  const n = (consecutiveChallenges.get(host) ?? 0) + 1;
  consecutiveChallenges.set(host, n);
  return n;
}

export function recordSuccess(url: string): void {
  consecutiveChallenges.delete(hostOf(url));
}

export function challengeCount(url: string): number {
  return consecutiveChallenges.get(hostOf(url)) ?? 0;
}
