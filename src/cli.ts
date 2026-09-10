#!/usr/bin/env node
import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { run, closeBrowser } from './pipeline.js';
import { openStore } from './store/open.js';
import { SOURCES, registryStats, ADAPTERS } from './sources/index.js';
import { probeSources, formatProbeTable } from './probe.js';
import { recallsFor } from './enrich/recalls.js';
import { decodeVin } from './enrich/vpic.js';
import { ask } from './nl/index.js';

const program = new Command();
program.name('carsearch').description('One search across every place a car is listed for sale.').version('0.1.0');

/**
 * A price, with its currency when that is not dollars.
 *
 * Six of the wired sources quote in CAD, GBP, ARS or PKR, and a bare `$` on
 * them reads as a US price: a PKR 74,500,000 Panamera printed as $74,500,000,
 * which is a plausible-looking number for the wrong car by a factor of 260. The
 * index deliberately stores the seller's own currency rather than converting,
 * so the display is the only place that can say which one it is.
 */
const money = (n: number | null, currency?: string | null) => {
  if (n === null) return '     -';
  const amount = n.toLocaleString('en-US');
  return !currency || currency === 'USD' ? `$${amount}` : `${currency} ${amount}`;
};

program
  .command('sources')
  .description('List the source registry and its coverage')
  .option('--status <status>', 'filter by status')
  .option('--country <cc>', 'filter by country code')
  .action((o: { status?: string; country?: string }) => {
    const st = registryStats();
    console.log(`\n${st.total} sources across ${st.countries.length} countries\n`);
    console.log('by status:   ', JSON.stringify(st.byStatus));
    console.log('by transport:', JSON.stringify(st.byTransport));
    console.log('adapters wired:', ADAPTERS.length, `(${ADAPTERS.map((a) => a.source.id).join(', ')})\n`);

    let rows = SOURCES;
    if (o.status) rows = rows.filter((s) => s.status === o.status);
    if (o.country) rows = rows.filter((s) => s.countries.includes(o.country!.toUpperCase()));
    for (const s of rows) {
      console.log(
        `${s.id.padEnd(22)} ${s.status.padEnd(18)} ${s.transport.padEnd(8)} ${s.category.padEnd(20)} ${s.countries.join(',')}`,
      );
    }
    console.log(`\n${rows.length} shown`);
  });

program
  .command('probe')
  .description('Test every source with BOTH transports and report drift from what the registry claims')
  .argument('[sources...]', 'specific source ids, or omit for all non-planned sources')
  .option('--json <path>', 'write full results to a JSON file')
  .action(async (ids: string[], o: { json?: string }) => {
    console.log(
      'Probing all three transports. Plain fetch, a real browser and a Chrome TLS fingerprint\n' +
        'disagree in every direction, and the TLS leg runs only once the cheaper two have failed.\n',
    );
    const results = await probeSources(ids);
    console.log(formatProbeTable(results));
    const drifted = results.filter((r) => r.drifted);
    console.log(`\n${results.length} probed, ${drifted.length} drifted from the registry.`);
    if (drifted.length) {
      console.log('Update src/sources/registry.ts for:');
      for (const d of drifted) console.log(`  ${d.sourceId}: declared ${d.declared}, observed ${d.observed}`);
    }
    if (o.json) {
      writeFileSync(o.json, JSON.stringify(results, null, 2));
      console.log(`\nwrote ${o.json}`);
    }
    await closeBrowser();
  });

program
  .command('search')
  .description('Run a real aggregated search across every wired source')
  .option('--make <make>', 'make, e.g. porsche')
  .option('--model <models>', 'comma-separated models; queried separately because each gets its own result quota')
  .option('--min-year <n>', 'minimum model year', Number)
  .option('--max-year <n>', 'maximum model year', Number)
  .option('--max-price <n>', 'maximum price', Number)
  .option('--min-price <n>', 'minimum price', Number)
  .option('--max-miles <n>', 'maximum mileage', Number)
  .option('--zip <zip>', 'origin zip', '92101')
  .option('--sources <ids>', 'comma-separated source ids to run')
  .option('--no-enrich', 'skip VIN decoding')
  .option('--concurrency <n>', 'sources to crawl at once (1 disables concurrency)', Number)
  .option('--db <path>', 'sqlite path', 'data/carsearch.db')
  .option('--json <path>', 'write results to a JSON file')
  .action(async (o: Record<string, unknown>) => {
    const store = await openStore({ sqlitePath: o.db as string });
    const result = await run({
      query: {
        make: o.make as string | undefined,
        models: o.model ? String(o.model).split(',').map((s) => s.trim()) : undefined,
        yearMin: o.minYear as number | undefined,
        yearMax: o.maxYear as number | undefined,
        priceMin: o.minPrice as number | undefined,
        priceMax: o.maxPrice as number | undefined,
        mileageMax: o.maxMiles as number | undefined,
        zip: o.zip as string,
      },
      store,
      sourceIds: o.sources ? String(o.sources).split(',').map((s) => s.trim()) : undefined,
      enrich: o.enrich !== false,
      concurrency: o.concurrency as number | undefined,
    });

    console.log('\n==== RESULT ====');
    console.log('kept      ', result.listings.length);
    console.log('rejected  ', result.rejected.length, JSON.stringify(result.stats.rejectReasons));
    console.log('by source ', JSON.stringify(result.stats.bySource));
    console.log('dedupe    ', JSON.stringify(result.stats.dedupe));
    console.log('integrity ', result.stats.priceIntegrity);
    console.log('duration  ', `${(result.stats.durationMs / 1000).toFixed(1)}s`);
    if (result.stats.sourcesFailed.length) console.log('failed    ', result.stats.sourcesFailed.join(', '));

    const asks = result.groups.filter((g) => g.primary.priceKind === 'ask');
    const sold = result.listings.filter((l) => l.priceKind === 'sold');
    console.log(`\n---- ${Math.min(20, asks.length)} of ${asks.length} unique cars for sale ----`);
    for (const g of asks.slice(0, 20)) {
      const p = g.primary;
      const badge = g.sources.length > 1 ? ` [${g.sources.length} sites]` : '';
      console.log(
        `${money(p.price, p.currency).padStart(13)}  ${String(p.mileage ?? '-').padStart(7)} mi  ${(p.title || '').slice(0, 52).padEnd(52)} ${p.sourceId}${badge}`,
      );
    }
    if (sold.length) {
      console.log(`\n---- ${Math.min(10, sold.length)} of ${sold.length} COMPLETED SALES (what the market actually paid) ----`);
      for (const s of sold.slice(0, 10)) {
        console.log(`${money(s.price).padStart(9)}  ${(s.eventDate ?? '').padEnd(11)} ${(s.title || '').slice(0, 55)}`);
      }
    }

    if (o.json) {
      writeFileSync(o.json as string, JSON.stringify({ groups: result.groups, stats: result.stats }, null, 2));
      console.log(`\nwrote ${o.json}`);
    }
    await store.close();
    await closeBrowser();
    if (process.env.CARSEARCH_TRACE) {
      console.log(`  [trace] holding node open: ${JSON.stringify(process.getActiveResourcesInfo())}`);
    }
  });

program
  .command('comps')
  .description('Completed sale prices for a vehicle, the number no incumbent shows')
  .requiredOption('--make <make>')
  .requiredOption('--model <model>')
  .option('--min-year <n>', 'minimum model year', Number, 1900)
  .option('--max-year <n>', 'maximum model year', Number, new Date().getFullYear() + 1)
  .option('--db <path>', 'sqlite path', 'data/carsearch.db')
  .action(async (o: Record<string, unknown>) => {
    const store = await openStore({ sqlitePath: o.db as string });
    const c = await store.soldComps(o.make as string, o.model as string, o.minYear as number, o.maxYear as number);
    if (c.count === 0) {
      console.log('No completed sales recorded yet. Run a search including bringatrailer or carsandbids first.');
      await store.close();
      return;
    }
    console.log(`\n${c.count} completed sales, ${o.minYear}-${o.maxYear} ${o.make} ${o.model}`);
    console.log(`median ${money(c.median)}   low ${money(c.low)}   high ${money(c.high)}\n`);
    for (const s of c.sales) {
      console.log(`${money(s.price).padStart(9)}  ${(s.event_date ?? '').padEnd(11)} ${s.title.slice(0, 60)}`);
    }
    await store.close();
  });

program
  .command('vin')
  .description('Decode a VIN through NHTSA vPIC, including the factory series code')
  .argument('<vin>')
  .action(async (vin: string) => {
    const d = await decodeVin(vin);
    if (!d) {
      console.log('Could not decode that VIN.');
      return;
    }
    for (const k of ['ModelYear', 'Make', 'Model', 'Trim', 'Series', 'BodyClass', 'DriveType', 'EngineCylinders', 'DisplacementL', 'FuelTypePrimary', 'PlantCountry'] as const) {
      if (d[k]) console.log(`${k.padEnd(18)} ${d[k]}`);
    }
  });

program
  .command('recalls')
  .description('Open recall campaigns, including the do-not-park flags')
  .requiredOption('--make <make>')
  .requiredOption('--model <model>')
  .requiredOption('--year <n>', 'model year', Number)
  .action(async (o: { make: string; model: string; year: number }) => {
    const r = await recallsFor(o.make, o.model, o.year);
    if (!r || r.count === 0) {
      console.log('No recall campaigns found.');
      return;
    }
    console.log(`\n${r.count} campaigns for ${o.year} ${o.make} ${o.model}`);
    if (r.parkIt) console.log('WARNING: an open campaign says DO NOT DRIVE.');
    if (r.parkOutSide) console.log('WARNING: an open campaign says PARK OUTSIDE, fire risk.');
    for (const c of r.campaigns.slice(0, 10)) {
      console.log(`\n${c.NHTSACampaignNumber}  ${c.Component}`);
      console.log(`  ${c.Summary.slice(0, 160)}`);
    }
  });

program
  .command('ask')
  .description('Search in plain English, e.g. "an old g wagon" or "porsche macan under 40k"')
  .argument('<question...>')
  .option('--db <path>', 'sqlite path', 'data/carsearch.db')
  .option('--parse-only', 'show how the question was understood without searching')
  .action(async (words: string[], o: { db: string; parseOnly?: boolean }) => {
    const text = words.join(' ');
    const parsed = await ask(text);

    console.log(`\nasked      "${text}"`);
    console.log(`parser     ${parsed.parser}`);
    console.log('understood');
    for (const line of parsed.interpretation) console.log(`  - ${line}`);
    console.log('query     ', JSON.stringify(parsed.query));
    if (o.parseOnly) return;

    const store = await openStore({ sqlitePath: o.db });
    const q = parsed.query;
    const rows = await store.search({
      make: q.make,
      model: q.models?.[0],
      yearMin: q.yearMin,
      yearMax: q.yearMax,
      priceMin: q.priceMin,
      priceMax: q.priceMax,
      mileageMax: q.mileageMax,
      bodyType: q.bodyType,
      fuelType: q.fuelType,
      text: q.keywords,
      priceKinds: q.priceKinds ?? ['ask'],
      limit: 25,
    });
    console.log(`\n${rows.length} matches in the index`);
    for (const r of rows) {
      console.log(`${money(r.price, r.currency).padStart(13)}  ${String(r.mileage ?? '-').padStart(7)} mi  ${(r.title || '').slice(0, 50).padEnd(50)} ${r.sourceId}`);
    }
    if (rows.length === 0) {
      console.log('The index only holds what has been crawled. Run `search` for this vehicle first.');
    }
    await store.close();
  });

program
  .command('stats')
  .description('What is in the database')
  .option('--db <path>', 'sqlite path', 'data/carsearch.db')
  .action(async (o: { db: string }) => {
    const store = await openStore({ sqlitePath: o.db });
    const s = await store.stats();
    console.log(JSON.stringify(s, null, 2));
    await store.close();
  });

program.parseAsync(process.argv).catch(async (e) => {
  console.error(e);
  await closeBrowser();
  process.exit(1);
});
