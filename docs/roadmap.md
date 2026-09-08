# Roadmap

Ordered by value per unit of work, not by ease. Updated 2026-09-08.

## Where things stand

15 adapters wired against 98 catalogued sources; 18 sources contribute rows.
The index holds roughly 7,300 listings and 1,900 completed sales.

```
autotempest  bringatrailer  craigslist  carscom  copart  cargurus  carvana
carmax  dupontregistry  carsandbids  autoscout24  pcarmarket  hagertymarketplace
finnno  blocket
```

## Next

### Owner count and accident history

**The largest remaining product gap, and the one users ask for by name.**
`titleStatus` is at 14% and climbing, entirely on the back of Copart, which
states a brand on every lot. `owners` sits at 1% and `accidents` at 0%.

What has been established, so the next attempt does not repeat it:

- **The data is in no search-results payload.** Not on CarGurus tiles, not in
  Cars.com card JSON, not in Carvana's flight payload. Checked directly.
- **It is not in detail-page HTML either.** A TLS fetch of a CarGurus, Carvana
  or Bring a Trailer detail page contains no history phrasing at all; those
  sections render client side.
- **Driving detail pages through the browser transport hung.** Four pages, one
  per source, with an eight-second settle and a scroll, produced no output in
  eighteen minutes and left no Chromium process alive. Before building a
  pipeline on this, find out whether the hang is a challenge-retry loop, since
  the symptom matches one, and cap the work per page accordingly.
- **Private sellers volunteer it in the title**, which is why Craigslist alone
  supplies most of the current `owners` coverage. The extraction for that text
  already exists in `enrich/text-facets.ts`.

The honest options, in order of expected value:

1. **A bounded browser pass over shortlisted cars only**, never the whole index.
   A user looking at twenty results can afford twenty page loads; 7,300 cannot.
2. **NMVTIS**, the federal title database, through an approved provider at
   roughly $10 a report. The only route that yields a verified answer rather
   than a seller's claim. Pre-filter with the free signals so it is only spent
   on a car someone is about to travel to see.
3. **More salvage-auction coverage.** It does not answer "how many owners", but
   it is the only free source that answers "what is the title".

### More sources

The tooling makes each roughly an afternoon rather than a week: see
[wiring-a-source.md](wiring-a-source.md). Highest value remaining:

- **eBay Motors** has a documented, free Browse API and needs only a developer
  key. Best value per hour of anything left.
- **Collecting Cars** returns current bid, sold price and buy-now as separate
  fields plus mileage and transmission, the best payload found anywhere. Every
  request shape tried returns 401; the likely cause is a scoped Typesense key
  naming a collection other than the guessed one.
- **Mecum, Barrett-Jackson, RM Sotheby's, Bonhams** are all completed-sale
  sources, which is the scarcest input the index has.
- **Facebook Marketplace** is the largest private-party pool in the country and
  is login-walled. An honest gap until proxies or a paid actor are budgeted.

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
