# Wiring a source

98 sources are catalogued; 8 are wired. This is the procedure for the rest, in
the order that fails fastest.

The expensive part is never writing the adapter. It is discovery: which
transport reaches the site, and where the data actually lives. Both questions
now have tools, and the answer to each is a measurement, never an assumption.

## 1. Which transport reaches it

There are three, and **none of them predicts the others**. Sites have been found
that answer a plain fetch and refuse a real browser, and sites that refuse both
and answer a third thing.

| Transport | Cost | Use when |
|---|---|---|
| `fetch` | nothing | It works. Always try first. |
| `tls` ([src/transport/tls.ts](../src/transport/tls.ts)) | almost nothing | A plain fetch gets 403. |
| `browser` ([src/transport/browser.ts](../src/transport/browser.ts)) | a renderer and ~1s | The page needs JavaScript to produce its data. |

The TLS transport exists because several CDNs fingerprint the TLS handshake
itself. Node's does not look like any browser's, so they refuse before a single
header is read. It has a per-host profile and remembers the winner.

Measured on 2026-09-08, it is the only transport that reaches **Carvana** (403
to fetch, 403 to Chromium, 200 and 1.2MB here), PCARMARKET and Collecting Cars.
It is not a universal key: Hemmings, AutoNation, Edmunds, EchoPark, TrueCar and
Carsforsale refuse every profile available.

**Record what you measure in the registry**, including failures. A `blocked`
entry with a note saying which profiles were tried saves the next person the
experiment. Four entries were found to be wrong precisely because nobody had
recorded how they were tested.

## 2. Where the data lives

In descending order of how long the adapter will survive:

**A documented API.** Rare, and worth a lot. [enrich/epa.ts](../src/enrich/epa.ts)
is the model: free, keyless, cannot block you, cannot change its markup.

**schema.org JSON-LD.** Published for search engines, which gives the site a
reason to keep it correct. [sources/jsonld.ts](../src/sources/jsonld.ts) reads
it, and a source that ships an `ItemList` is roughly fifteen lines of adapter.
Craigslist is one: 337 items from a single request.

```bash
curl -s <url> | grep -o 'application/ld+json' | wc -l
```

**A JSON endpoint the frontend calls.** Most listing sites are single-page apps
now. The endpoint underneath is the site's contract with its own client, so it
is richer and far more stable than the DOM it renders.

```bash
npx tsx scripts/find-endpoint.ts <url> --scroll
```

That prints every JSON response the page fetched, largest first, with the shape
of each array so the inventory is obvious. It found Collecting Cars' search
index in one run.

**A React Flight payload.** Next.js App Router sites stream their data as
`self.__next_f.push(...)` fragments in the HTML, so there is no XHR to find and
`find-endpoint` comes back empty even though the data is right there.
[sources/nextjs.ts](../src/sources/nextjs.ts) reconstructs it.

```ts
const records = findRecords<Vehicle>(html, 'vehicleId');
```

**The rendered DOM.** Last resort. Class names are hashed per build, so an
adapter written against them has a shelf life measured in weeks. CarGurus was
rewritten off its DOM for exactly this reason, and reading its payload instead
also gained three more listings a page and full VIN coverage.

## 3. Write the adapter

Implement `SourceAdapter`, build drafts with `makeListing` so unstated fields
default to null, and return `[...out.values()].map(makeListing)`.

Three rules that every past bug traces back to:

**Read prices from a specific field, never a page-wide scan.** A loose scan once
produced a "2026 Porsche 911 Targa 4 GTS, $25,476" whose real comparables were
$185,069.

**Never stamp the requested make or model onto a result.** Read it from the
row's own title. A search fallback that silently ignored the query returned 159
Mustangs, Corvettes and an NSX, every one labelled as the G-Class that had been
asked for. If a search endpoint cannot be shown to have filtered, discard what
it returned: an empty result is honest, and a page of unrelated cars wearing the
requested model is not.

**Separate `ask`, `bid` and `sold`.** They are three different quantities. A
current bid is not a price anyone has paid.

## 4. Prove it

```bash
npx tsx src/cli.ts search --make porsche --model macan --sources <id> --concurrency 1
```

Read the whole summary, not the count:

- **`integrity`** flags a suspect ratio of records to distinct prices. When it
  fired on Craigslist it was right, and not about a pairing bug: 191 cars were
  priced at exactly $1,500 because buy-here-pay-here dealers post the down
  payment in the price field.
- **`rejected`** with reasons. A source rejecting most of its rows means the
  parser is wrong, not the site.
- **The titles themselves.** Every wrong-data bug in this repo's history was
  visible in the first twenty lines of output and invisible in the counts.

Then add the source to `ADAPTERS`, update its registry entry with what you
measured, and run `scripts/backfill-facets.ts` so the new rows pick up VIN and
model-level facets.

**If it does not work, do not ship it in `ADAPTERS`.** Leave the file, write
down exactly what is known and what the next attempt should try, and mark the
registry accordingly. `sources/collectingcars.ts` is the worked example: a real
endpoint, a good payload, and a 401 nobody has cracked yet.

## Currently wired

`autotempest` `carscom` `carmax` `cargurus` `bringatrailer` `carsandbids`
`craigslist` `carvana`

## Next, in value order

1. **Copart** salvage, reachable by plain fetch (267KB), endpoint not yet found.
2. **Autotrader** the largest US marketplace; returns 200, body is a 4KB shell.
3. **PCARMARKET** Porsche auctions, server-rendered, needs the right URL.
4. **Collecting Cars** endpoint found, request shape unresolved.
5. **eBay Motors** has a real documented API and needs only a developer key.
