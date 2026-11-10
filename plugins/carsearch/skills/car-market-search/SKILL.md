---
name: car-market-search
description: Search used-car listings across many sources, decode VINs, look up recalls and compare asking prices against completed sales with the carsearch CLI and JSON API. Use when the user wants to find, price or research a specific car.
---

# carsearch

carsearch aggregates vehicle listings from marketplaces, dealer inventory and auctions, dedupes them by VIN, and compares asking prices with what comparable cars sold for. The package is private and not on npm, so run it from a clone of https://github.com/nirholas/carsearch. Requires Node 20 or newer.

## Setup

```bash
git clone https://github.com/nirholas/carsearch && cd carsearch
npm install
npx playwright install chromium   # browser transport, needed by several sources
```

`ANTHROPIC_API_KEY` is optional. With it, `ask` falls back to Claude for sentences the pattern parser cannot read. Without it the pattern parser answers alone.

## CLI (run with `npx tsx src/cli.ts <command>`)

| Command | Purpose |
|---|---|
| `sources [--status <s>] [--country <cc>]` | List the source registry and which adapters are wired. |
| `probe [sources...] [--json <path>]` | Check each source with both transports and report drift. |
| `search` | Run an aggregated crawl and print ranked, deduplicated listings. |
| `comps --make <m> --model <m>` | Median ask against median sold. Also takes `--min-year`, `--max-year`, `--db`. |
| `vin <vin>` | Decode a VIN through NHTSA vPIC, including the factory generation code. |
| `recalls --make <m> --model <m> --year <n>` | Open recall campaigns, including do-not-park flags. |
| `ask "<question>"` | Plain-English search. `--parse-only` shows the interpretation without searching. |
| `stats` | Summarise the local database. |

`search` flags: `--make`, `--model` (comma separated), `--min-year`, `--max-year`, `--min-price`, `--max-price`, `--max-miles`, `--zip` (default 92101), `--sources <ids>`, `--no-enrich`, `--concurrency <n>`, `--db <path>` (default `data/carsearch.db`), `--json <path>`.

## JSON API

`npm run serve` starts the server on http://localhost:8787.

- `GET /api/search`: ranked results. `sort` takes a preset or a blend such as `mileage+price` or `mileage:2+price:1`. Facets are query parameters (`make`, `model`, `yearMin`, `yearMax`).
- `GET /api/facets`: filterable attributes with real coverage.
- `GET /api/market`: market report for one model, with an optional `mileage` valuation.
- `GET /api/comps`: median ask against median sold.
- `POST /api/ask` with `{"q": "..."}`: plain-English search, returns the interpretation with results.
- `GET /api/auctions`: live bids and completed sales.
- `GET /api/sources`: the registry.

## Worked example

```bash
npx tsx src/cli.ts search --make porsche --model macan --min-year 2017 --max-year 2017 --max-price 40000 --json out.json
npx tsx src/cli.ts comps --make porsche --model macan
npx tsx src/cli.ts vin WP1AB2A56LLB33982
```

## Rules for agents

- Crawls hit live third-party sites. Keep `--concurrency` low and scope with `--sources`.
- The tool reports unknowns as unknown. Do not fill missing prices, mileage or valuations yourself.
- A result with no sold data means no valuation is possible; say so instead of estimating.
