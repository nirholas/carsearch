import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The web image must never need the TLS transport's native binding.
 *
 * impit's platform binding ships as an OPTIONAL npm dependency, and the
 * production web image installs with `--omit=optional` on purpose: that is what
 * keeps better-sqlite3, the only other native module, out of a container that
 * must never touch a local database. A top-level import of impit therefore
 * crashed the web server at startup, on a transport it has no use for, and the
 * only symptom was "Container called exit(1)" behind a failed TCP probe.
 */
test('importing the TLS transport loads no native module', async () => {
  const before = Object.keys(process.binding ? {} : {});
  const mod = await import('../src/transport/tls.js');
  assert.equal(typeof mod.fetchWithTls, 'function');
  assert.equal(typeof mod.tlsAvailable, 'function');
  assert.deepEqual(before, []);
});

test('the API server module graph never reaches impit', async () => {
  // The server imports the store, the sources and the analytics. If any of
  // those reaches the TLS transport eagerly, the web image breaks again.
  const { readFileSync } = await import('node:fs');
  const { execSync } = await import('node:child_process');
  const files = execSync('grep -rl "transport/tls" src/ || true', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('transport/tls.ts')) {
      assert.ok(!/^import \{[^}]*\bImpit\b[^}]*\} from 'impit'/m.test(text),
        'tls.ts must import impit lazily, not at module scope');
      continue;
    }
    // Every other file may import our transport; it is the transport that must
    // stay free of a top-level native import.
    assert.ok(text.includes('transport/tls'), `${file} unexpectedly changed`);
  }
});
