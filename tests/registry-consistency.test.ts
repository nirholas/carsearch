import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS } from '../src/sources/index.js';
import { SOURCES } from '../src/sources/registry.js';

/**
 * The registry is what /api/sources reports, and a source's status there is a
 * claim about whether the platform can actually read it.
 *
 * These drifted apart silently: three adapters were wired, crawling and
 * returning cars while their registry rows still said `planned`, so the API
 * under-reported its own coverage by three sources and nothing failed. A status
 * nobody checks is a comment, not a fact.
 */

const byId = new Map(SOURCES.map((s) => [s.id, s]));

test('every wired adapter has a registry row', () => {
  for (const a of ADAPTERS) {
    assert.ok(byId.has(a.source.id), `${a.source.id} has an adapter and no registry entry`);
  }
});

test('every wired adapter is recorded live', () => {
  for (const a of ADAPTERS) {
    const source = byId.get(a.source.id)!;
    assert.equal(source.status, 'live', `${a.source.id} is wired but its registry row says "${source.status}"`);
  }
});

test('nothing claims to be live without a way to read it', () => {
  const wired = new Set(ADAPTERS.map((a) => a.source.id));
  for (const s of SOURCES) {
    if (s.status !== 'live' || wired.has(s.id)) continue;
    /**
     * The enrichment APIs are the deliberate exception. They are live and have
     * no adapter because they answer questions about a car we already hold
     * rather than producing listings.
     */
    assert.equal(
      s.category, 'data-api',
      `${s.id} is marked live but has no adapter and is not a data API`,
    );
  }
});

test('a source id appears once', () => {
  const seen = new Set<string>();
  for (const s of SOURCES) {
    assert.ok(!seen.has(s.id), `${s.id} is in the registry twice`);
    seen.add(s.id);
  }
});
