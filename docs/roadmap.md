# Roadmap

Ordered by value per unit of work, not by ease. Updated 2026-09-08.

## Where things stand

16 adapters wired against 98 catalogued sources; 19 sources contribute rows.
The index holds 11,171 listings and 1,906 completed sales, with 13,179 price
points. Kelley Blue Book is the largest single source at 3,809 listings from a
crawl that covered only four of its twenty-eight makes before being interrupted.

```
autotempest  bringatrailer  craigslist  carscom  copart  cargurus  carvana
carmax  kbb  dupontregistry  carsandbids  autoscout24  pcarmarket
hagertymarketplace  finnno  blocket
```

## Next

### Owner count and accident history

**Largely solved on 2026-09-08 by wiring Kelley Blue Book.** Every KBB record
carries a `vhrPreview` history-flag set on the search page itself, so the data
arrives with the listing rather than needing a per-car lookup. On the first real
crawl, 308 of 311 McLarens carried accident data and 116 carried an owner count,
against `owners` at 1% and `accidents` at 0% across every other source combined.
See [sources.md](sources.md#why-kelley-blue-book-is-the-most-valuable-source-here)
for exactly what each flag is allowed to assert.

Two limits are worth stating plainly, because both are permanent properties of
the data rather than gaps to close:

- **`NO_ONE_OWNER` gives no count.** It says more than one owner and stops there,
  so it yields null rather than a fabricated 2. Same for `ACCIDENTS_REPORTED`,
  which is a boolean with no number behind it.
- **`NO_SALVAGE_TITLE` is not a clean title.** It leaves rebuilt, flood and lemon
  open, and is deliberately not mapped to `titleStatus`. `titleStatus` therefore
  still climbs mainly on Copart, which states a real brand on every lot.

What remains, in order of expected value:

1. **Run the KBB pass across more of the market.** `scripts/kbb-index.sh` does
   this per make. Coverage on these fields is now a function of how much of the
   index has been through it, which is a crawl-time problem, not a research one.
2. **NMVTIS**, the federal title database, through an approved provider at
   roughly $10 a report. Still the only route to a verified answer rather than a
   dealer's report summary, and the only one that resolves an exact owner count.
   Pre-filter with the free signals so it is spent only on a car someone is about
   to travel to see.
3. **A bounded browser pass over shortlisted cars only**, never the whole index,
   for sources KBB does not carry. Note the prior finding: four detail pages with
   an eight-second settle produced no output in eighteen minutes and left no
   Chromium alive. Find out whether that hang is a challenge-retry loop before
   building anything on it.

Private sellers still volunteer owner counts in listing text, which is why
Craigslist supplies the private-party share of this coverage; that extraction
lives in `enrich/text-facets.ts`.

### Price history

**Also largely addressed by KBB.** Price points could previously only be
accumulated forward, one crawl at a time, so every listing started with an empty
history. KBB publishes a dated series going back to listing day on roughly a
third of records, and `Listing.priceHistory` seeds those into `price_points` on
first insert. Everything else still fills in only by observing a car twice, which
is what the crawler job is for.

### More sources

The tooling makes each roughly an afternoon rather than a week: see
[wiring-a-source.md](wiring-a-source.md). Highest value remaining:

- **eBay Motors** has a documented, free Browse API and needs only a developer
  key. Best value per hour of anything left. It already reaches the index
  second-hand through AutoTempest, which attributes listings to their origin
  site; the API would add completed-sale data that the passthrough does not.
- **Collecting Cars** returns current bid, sold price and buy-now as separate
  fields plus mileage and transmission, the best payload found anywhere. Every
  request shape tried returns 401; the likely cause is a scoped Typesense key
  naming a collection other than the guessed one.
- **Mecum, Barrett-Jackson, RM Sotheby's, Bonhams** are all completed-sale
  sources, which is the scarcest input the index has.
- **Facebook Marketplace** is the largest private-party pool in the country and
  is login-walled. An honest gap until proxies or a paid actor are budgeted.

Autotrader specifically is no longer worth attacking. It is Cox Automotive, and
so is Kelley Blue Book: KBB serves its images from `atcimages.kbb.com` and is
largely the same dealer inventory, through a door that is open.

Confirmed blocked to all three transports, with evidence in the registry so
nobody re-runs the experiment: Autotrader (a 200 carrying a reCAPTCHA shell,
which is the most deceptive refusal there is), Hemmings, TrueCar, EchoPark,
Carsforsale, Autolist, iSeeCars, Car & Classic, GSA Auctions, mobile.de,
Auto Trader UK, La Centrale, Carsales AU, Encar, SgCarMart, Webmotors.

### Depth over breadth

**Price history only accumulates while the clock runs, and cannot be
backfilled.** Every day the crawler does not run is a day of days-on-market and
price-drop data that no competitor can re-scrape and neither can we. The
crawler image is built and pushed; its Cloud Run Job and schedule are not
created. That is the highest-value unglamorous task left.

**Completed sales are the scarcest input.** Every statistic on the market
dashboard rests on them, and several are currently withheld for want of a
sample: the 911's depreciation curve is refused because seven sales spanning a
1972 911E and a 1986 Turbo cannot separate mileage from variant. Bring a
Trailer alone publishes years of results, and one G-Class crawl took that model
from 18 asking prices to 119 completed sales spanning eleven years.

## Known gaps in what is built

- **`openRecall`, `batteryKwh` and `dealerRating` have no coverage.** The recall
  enrichment exists and is not wired into the backfill.
- **Hagerty is thin**: ten to fifteen live lots from the landing page, and no
  URL found that lists completed sales, which is the half worth having.
- **Cross-currency comparison is prevented, not solved.** Search and the market
  dashboard scope to one currency, which is correct but means a European
  listing never appears beside a US one. Fixing it properly needs dated
  exchange rates stored beside each price, so a conversion is reproducible
  rather than a snapshot of today.
