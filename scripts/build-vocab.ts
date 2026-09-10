import { writeFileSync } from 'node:fs';
import pLimit from 'p-limit';

/**
 * Builds `data/vehicle-vocab.json` from the free NHTSA vPIC catalogue.
 *
 * `src/nl/vocabulary.ts` has always said this file supersedes its hand-written
 * seed, and the seed carries 47 makes against vPIC's 195. Until this script
 * existed the file was never built, so every make outside the seed was invisible
 * to three separate things: natural-language search could not name it, the crawl
 * scripts hardcoded their own shorter lists, and `trim.ts` could not infer a
 * make from a model for it.
 *
 * No key, no rate limit observed, and the whole catalogue is one request per
 * make. Re-run it whenever the crawl should reach further.
 *
 *   npx tsx scripts/build-vocab.ts
 *   npx tsx scripts/build-vocab.ts --vehicle-types car,truck,multipurpose
 */

const API = 'https://vpic.nhtsa.dot.gov/api/vehicles';

const arg = (name: string, fallback: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const idx = process.argv.indexOf(`--${name}`);
  if (hit) return hit.slice(name.length + 3);
  return idx >= 0 ? (process.argv[idx + 1] ?? fallback) : fallback;
};

/**
 * Passenger cars alone miss the SUVs and pickups that are most of the US
 * market, so the default spans the three types that carry consumer vehicles.
 */
const TYPES = arg('vehicle-types', 'car,truck,multipurpose passenger vehicle (mpv)')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function json<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return (await res.json()) as T;
}

const makes = new Map<string, string>();
for (const type of TYPES) {
  const d = await json<{ Results: { MakeName: string }[] }>(
    `${API}/GetMakesForVehicleType/${encodeURIComponent(type)}?format=json`,
  );
  for (const r of d.Results ?? []) {
    // vPIC SHOUTS every name. Title-case it, but leave the alphanumerics alone
    // so a designation such as BMW or GMC is not mangled into "Bmw".
    const name = r.MakeName.trim();
    const pretty = name.length <= 3 ? name : name.replace(/\b[A-Z][A-Z']*\b/g, (w) => w[0] + w.slice(1).toLowerCase());
    makes.set(name.toLowerCase(), pretty);
  }
  console.log(`${type}: ${d.Results?.length ?? 0} makes`);
}
console.log(`\n${makes.size} distinct makes across ${TYPES.length} vehicle types`);

const limit = pLimit(8);
const models: Record<string, string[]> = {};
let done = 0;

await Promise.all(
  [...makes.keys()].map((key) =>
    limit(async () => {
      try {
        const d = await json<{ Results: { Model_Name: string }[] }>(
          `${API}/GetModelsForMake/${encodeURIComponent(key)}?format=json`,
        );
        const list = [...new Set((d.Results ?? []).map((r) => r.Model_Name.trim()).filter(Boolean))];
        if (list.length) models[key] = list.sort();
      } catch {
        // A make with no model catalogue is still a real make. Keep it in
        // `makes` and leave its model list absent rather than dropping it.
      }
      done += 1;
      if (done % 25 === 0) console.log(`  ${done}/${makes.size} makes resolved`);
    }),
  ),
);

const out = {
  makes: [...makes.keys()].sort(),
  models,
};
writeFileSync('data/vehicle-vocab.json', `${JSON.stringify(out, null, 1)}\n`);

const total = Object.values(models).reduce((n, l) => n + l.length, 0);
console.log(`\nwrote data/vehicle-vocab.json: ${out.makes.length} makes, ${total} models`);
console.log('top catalogues:');
for (const [m, l] of Object.entries(models).sort((a, b) => b[1].length - a[1].length).slice(0, 10)) {
  console.log(`  ${String(l.length).padStart(4)}  ${m}`);
}
