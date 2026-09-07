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

Three things nobody gives you, which this project treats as first class:

1. **Deduplication by VIN.** The same car is listed on four sites at once. Listing counts everywhere
   else are inflated, and a buyer scrolling the same Macan five times has a worse experience than one
   who sees it once with five source badges.
2. **Price history.** Days-on-market and price drops are the highest-value signal in the category and
   they only exist if you snapshot daily. They cannot be backfilled, which also makes them the one
   asset a competitor cannot simply re-scrape.
3. **Sold prices, not just asks.** An asking price is what a seller hopes for. Everyone shows those.
   Nobody shows the gap between them and what the market paid.

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

# Web UI and JSON API
npm run serve      # http://localhost:8787
```

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

MIT
