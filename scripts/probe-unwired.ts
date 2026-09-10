import { SOURCES, ADAPTERS } from '../src/sources/index.js';
import { fetchWithTls } from '../src/transport/tls.js';

/**
 * Sweeps every registry source that has no adapter yet, across the transports,
 * and reports what shape its payload is in.
 *
 * The registry records reachability, which is not the same as extractability.
 * This answers the second question: given that a page comes back, is the
 * inventory in JSON-LD, in an embedded framework payload, or only in markup.
 * That decides whether wiring it is an hour or a day.
 */

const PROFILES = ['chrome', 'firefox133'] as const;
const BLOCK = /access denied|are you a human|unusual traffic|verify you are|captcha|just a moment|page unavailable|cf-browser/i;

/** JSON-LD blocks that actually describe vehicles or a list of them. */
function vehicleJsonLd(html: string): number {
  let n = 0;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    if (/"@type"\s*:\s*"(Car|Vehicle|Product|Offer|ItemList)"/i.test(m[1] ?? '')) n++;
  }
  return n;
}

interface Verdict {
  id: string; status: number | string; bytes: number; profile: string;
  jsonld: number; payload: number; prices: number; blocked: boolean;
}

async function probe(id: string, url: string): Promise<Verdict> {
  let best: Verdict = { id, status: 'ERR', bytes: 0, profile: '-', jsonld: 0, payload: 0, prices: 0, blocked: true };
  for (const p of PROFILES) {
    try {
      const r = await fetchWithTls(url, {}, { browser: p } as never);
      const b = r.body ?? '';
      const v: Verdict = {
        id, status: r.status, bytes: b.length, profile: p,
        // Counting ld+json BLOCKS is not the same as finding inventory: nearly
        // every site ships Organization and WebSite boilerplate, which made
        // three sources look extractable when their JSON-LD held no car at all.
        jsonld: vehicleJsonLd(b),
        payload: (b.match(/__NEXT_DATA__|__remixContext|self\.__next_f|__NUXT__|__INITIAL_STATE__/g) ?? []).length,
        prices: (b.match(/[$£€]\s?\d{1,3}[,.]\d{3}/g) ?? []).length,
        blocked: r.status !== 200 || BLOCK.test(b.slice(0, 4000)),
      };
      if (!v.blocked) return v;
      if (v.bytes > best.bytes) best = v;
    } catch { /* try the next profile */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return best;
}

async function main() {
  const wired = new Set(ADAPTERS.map((a) => a.source.id));
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const cands = SOURCES.filter(
    (s) => !wired.has(s.id) && s.status !== 'blocked' && s.category !== 'data-api' && (only.length === 0 || only.includes(s.id)),
  );
  console.log(`wired ${wired.size} / registry ${SOURCES.length}; probing ${cands.length}\n`);
  console.log('source                 status bytes     profile     ld payload prices verdict');

  /**
   * Eight at a time. These are all different hosts, so the throttle that makes
   * a per-source crawl sequential does not apply: nothing here hits the same
   * origin twice, and serially this sweep takes over an hour.
   */
  const queue = [...cands];
  const workers = Array.from({ length: 8 }, async () => {
    for (;;) {
      const s = queue.shift();
      if (!s) return;
      const v = await probe(s.id, s.homepage);
      const shape = v.blocked ? 'BLOCKED'
        : v.payload > 0 ? 'embedded payload'
        : v.jsonld > 0 ? 'json-ld'
        : v.prices > 3 ? 'html only'
        : 'no inventory on homepage';
      console.log(
        `${s.id.padEnd(22)} ${String(v.status).padEnd(6)} ${String(v.bytes).padStart(8)} ${v.profile.padEnd(11)} ` +
        `${String(v.jsonld).padStart(2)} ${String(v.payload).padStart(7)} ${String(v.prices).padStart(6)}  ${shape}`,
      );
    }
  });
  await Promise.all(workers);
}
main();
