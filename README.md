# carsearch

One search across every place a car is listed for sale.

`carsearch` aggregates vehicle listings from marketplaces, dealer inventory, auctions and salvage
yards, deduplicates them by VIN, normalizes trim and generation from the VIN itself, tracks price
history over time, and shows what comparable cars **actually sold for** next to what sellers are
asking.

## Why this exists

Every existing aggregator covers a slice. AutoTrader and Cars.com hold dealer inventory. Facebook
Marketplace and Craigslist hold most private-party supply. Bring a Trailer and Cars & Bids hold the
enthusiast market. Copart and IAA hold salvage. Manheim holds the wholesale prices that set all of
the above. Nothing spans them, and every open-source project that tried is abandoned.

Five things nobody gives you, which this project treats as first class:

1. **Deduplication by VIN.** The same car is listed on four sites at once. Listing counts everywhere
   else are inflated, and a buyer scrolling the same Macan five times has a worse experience than one
   who sees it once with five source badges.
2. **Price history.** Days-on-market and price drops are the highest-value signal in the category and
   they only exist if you snapshot daily. They cannot be backfilled, which also makes them the one
   asset a competitor cannot simply re-scrape.
3. **Sold prices, not just asks.** An asking price is what a seller hopes for. Everyone shows those.
   Nobody shows the gap between them and what the market paid.
4. **Ranking on two objectives at once.** A sort column answers "the cheapest one". Nobody asks that.
   They ask for the lowest-mileage one they can get without paying stupid money, which is a
   trade-off, so carsearch computes the Pareto frontier: the cars nothing else beats on every axis
   you ranked by. See [docs/ranking.md](docs/ranking.md).
5. **Market data that admits what it does not know.** Depreciation curves, price trends, a valuation
   for one specific car and a backtest on completed sales, each of which refuses to report a number
   the data cannot support. See [docs/market-data.md](docs/market-data.md).

## Quickstart

```bash
npm install
npx playwright install chromium

# What the registry knows about, and which adapters are wired
npx tsx src/cli.ts sources

# Check every source with BOTH transports and report drift from the registry
npx tsx src/cli.ts probe

# Run a real aggregated crawl
npx tsx src/cli.ts search --make porsche --model macan,911 --max-price 40000 --min-year 2016

# What the market actually paid, versus what sellers are asking
npx tsx src/cli.ts comps --make porsche --model macan

# Decode a VIN, including the factory generation code
npx tsx src/cli.ts vin WP1AB2A56LLB33982

# Open recall campaigns, including the do-not-park flags
npx tsx src/cli.ts recalls --make porsche --model taycan --year 2021

# Ask in plain English
npx tsx src/cli.ts ask "an old g wagon"
npx tsx src/cli.ts ask "what did a 2017 macan sell for"
npx tsx src/cli.ts ask --parse-only "porsche macan under 40k with low miles"

# Fill facet columns from data already held: cached VIN decodes and listing text
npx tsx scripts/backfill-facets.ts

# Web UI and JSON API
npm run serve      # http://localhost:8787
```

## The API

| Endpoint | Returns |
|---|---|
| `GET /api/search` | Ranked, deduplicated results. `sort` takes a preset or a blend (`mileage+price`, `mileage:2+price:1`). Every facet is a query parameter. |
| `GET /api/facets` | Every filterable attribute with its real coverage in the current scope. |
| `GET /api/market` | The market report for one model: distributions, depreciation curve, trend, backtest, and optionally a valuation for a given mileage. |
| `GET /api/comps` | Median ask against median sold, and the spread. |
| `POST /api/ask` | Plain-English search. Returns the interpretation alongside the results. |
| `GET /api/auctions` | Live bids and completed sales. |
| `GET /api/sources` | The registry: every source, its status, transport and access method. |

```bash
# The motivating query, three ways
curl 'localhost:8787/api/search?make=Porsche&model=Macan&yearMin=2017&yearMax=2017&sort=mileage%2Bprice'
curl -X POST localhost:8787/api/ask -H 'Content-Type: application/json' \
     -d '{"q":"2017 porsche macan lowest mileage and cheapest"}'
curl 'localhost:8787/api/market?make=Porsche&model=Macan&mileage=45000'
```

## Documentation

| Doc | Covers |
|---|---|
| [docs/ranking.md](docs/ranking.md) | The Pareto frontier, blended scores, and why ranking is not done in SQL |
| [docs/facets.md](docs/facets.md) | All 35 attributes, the coverage machinery, and the unknown-value policy |
| [docs/market-data.md](docs/market-data.md) | The dashboard, the valuation model, the backtest, and every honesty rule |
| [docs/sources.md](docs/sources.md) | The full platform survey |
| [docs/wiring-a-source.md](docs/wiring-a-source.md) | How to wire the next one: the three transports, where the data hides, and how to prove it |
| [docs/deploy.md](docs/deploy.md) | Cloud Run, Cloud Build, Neon |
| [docs/roadmap.md](docs/roadmap.md) | What is not built yet |
| [docs/handoff-2026-09-08.md](docs/handoff-2026-09-08.md) | Session record: Kelley Blue Book, the third transport, and why `git log` looks truncated |

## Asking in plain English

The search box takes a sentence, not a filter form. "an old g wagon" resolves to a Mercedes-Benz
G-Class from 2011 or earlier; "what did a 2017 macan sell for" switches from asking prices to
completed sales.

Parsing runs in two passes, deterministic first:

1. **Pattern parser** (`src/nl/parse.ts`) handles the shape most searches take: a nickname, a model,
   a budget, a mileage cap, a year range, a body style, an intent. No API key, no network call, no
   latency. This is the primary, not a fallback, because paying a model round trip to read
   "porsche macan under 40k" would be slower and worse.
2. **Claude** (`src/nl/llm.ts`) handles what patterns cannot enumerate: "something reliable for a long
   commute that fits a car seat". It runs only when the pattern parser found nothing or left a
   meaningful part of the sentence unexplained. Set `ANTHROPIC_API_KEY` to enable it; without a key
   the pattern parser answers alone and says so.

Every constraint is shown back to the user. A search box that silently reinterprets the request is
worse than one that explains itself, so "old" reports the exact year it resolved to and the parse is
mirrored into the sidebar filters where it can be corrected.

## What is wired today

| Source | Role | Transport | Notes |
|---|---|---|---|
| AutoTempest | aggregator | browser | Reaches Carvana and TrueCar, which refuse direct access. Each tile names its origin site, so listings are re-attributed to where the car actually lives. |
| Cars.com | dealer inventory | browser | The full record is JSON in a `data-vehicle-details` attribute, richer than the rendered card. |
| CarMax | retailer | browser | The only source publishing VINs in listing markup, so it dedupes exactly. |
| Bring a Trailer | completed sales | browser | The sold-price backbone. |
| Cars & Bids | completed sales | browser | Modern enthusiast cars. |
| NHTSA vPIC | enrichment | fetch | Free VIN decode including the factory generation code. |
| NHTSA Recalls | enrichment | fetch | Free, including the park-it and park-outside flags. |

The registry in [src/sources/registry.ts](src/sources/registry.ts) tracks 98 sources across 34
countries. It is deliberately larger than the set of wired adapters: a source recorded as `blocked`
is a measurement, and it stops the next person re-testing it blindly or mistaking a known gap for an
oversight.

## Architecture

```
src/
  core/         types, normalization, plausibility, deduplication
  transport/    two-transport fetcher, browser pool, per-host throttling
  sources/      the source registry and one adapter per site
  enrich/       VIN decode and recall lookup
  store/        SQLite schema and queries, including price history
  api/          JSON API and the web UI it serves
  probe.ts      reachability prober
web/            the UI
```

### Two transports, not one

The load-bearing finding. A plain HTTP request and a real browser get different answers **in both
directions**, and neither predicts the other. A single-transport design silently loses whichever set
it cannot reach, and the failure looks like thin coverage rather than a bug.

On the morning of 7 September 2026 Cars.com served a plain fetch and blocked a browser. By that
evening it had flipped. Nothing in this codebase changed. A source declaration is a measurement with
a timestamp, never a fact, which is why `probe` exists and why it reports drift rather than assuming
the registry is right.

### Everything fails quietly, so nothing is allowed to

The recurring failure mode in this category is not an error, it is a plausible wrong answer:

- A Cloudflare challenge returns HTTP 200 with zero cards, which reads as "no cars match" rather than
  "you asked too fast". Handled by per-host pacing, waiting out JavaScript interstitials, and
  exponential backoff.
- Pairing prices to listings by page-wide regex gives every car in a line the same price. Guarded by
  asserting the ratio of distinct prices to records after every extraction.
- A flat price floor cannot tell a bad parse from a cheap car. Plausibility is measured against the
  median of a listing's own peer group instead.
- Auction sites list memorabilia. A full-scale display model sold for $2,700 and parsed as a real car.
- Rejects are stored with a reason rather than dropped, because silent filtering hides parser rot.

## License

Copyright (c) 2026. All rights reserved.

Proprietary and confidential. This is not open-source software. No permission is granted to use,
copy, modify, or distribute this code without prior written consent. See [LICENSE](LICENSE).

Third-party dependencies keep their own licenses, and every one currently in use is permissive
(MIT or Apache-2.0). Nothing copyleft is linked, so the proprietary status of this codebase holds.
