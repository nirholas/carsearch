# Roadmap

Ordered by value per unit of work, not by ease.

## Next

**More adapters, starting with the ones already probed reachable.** CarGurus (browser, 33 prices and a
JSON-LD block) and PCARMARKET (browser, 43KB of rendered text) both answered a real browser on
2026-09-07 and have no adapter yet. Copart needs its internal JSON endpoint found, since both
transports render nothing useful.

**Concurrency in the pipeline.** Sources run serially today. They are independent hosts and the
throttle is already per host, so wiring `p-limit` into the adapter loop turns a nine-minute two-model
crawl into roughly the slowest single source. This is the blocker on a nightly crawl across many
models.

**Vehicle vocabulary from vPIC.** The catalogue endpoint returns 403 to a plain fetch from a
datacenter address, so it needs routing through the two-transport fetcher like everything else. Until
then the parser runs on the seed vocabulary in `src/nl/vocabulary.ts`.

## Vehicle history per VIN

The product gap: a listing shows price and mileage but nothing about title brands, accident records,
odometer rollback or owner count. Nothing in the index currently answers "is this specific car sound",
and that is the question a buyer most wants answered before travelling to see it.

**Free and already wired:** NHTSA vPIC decodes the VIN to year, make, model, trim and factory series,
and NHTSA recalls returns open campaigns including the do-not-drive and park-outside flags. That is
real safety data no incumbent aggregator surfaces next to a listing.

**Not covered by those:** title brands, accident history, odometer readings over time, service records
and owner count. Those come from three routes, in ascending cost:

1. **NMVTIS** (`vehiclehistory.gov`), the federal title and brand database. Approved data providers
   resell single reports for a few dollars, far below a consumer-facing report, and the title-brand
   half is the part that actually stops a bad purchase. This is the right first integration.
2. **VinAudit / ClearVIN / EpicVIN**, which layer auction photo history and market value on top of
   NMVTIS at a similar price point, with real APIs.
3. **Carfax or AutoCheck partner APIs**, which have the deepest service-record coverage and the
   consumer brand recognition, and are priced accordingly.

**On the "add it as my vehicle" shortcut:** registering a VIN you do not own in a consumer app to pull
a free report means asserting ownership you do not have, which breaks that service's terms and would
not survive being done at any scale. It is also unnecessary. NMVTIS is the same underlying title data,
is officially licensed for resale, costs a few dollars per report, and can be shown to users without
the integration being a liability. Route the feature through NMVTIS first and treat a Carfax partner
agreement as the paid upgrade.

## Later

- Facebook Marketplace and Craigslist, which hold most US private-party supply and both punish
  automation. Needs residential proxies budgeted, or the gap stated plainly in the UI.
- eBay Browse API, the only large free documented listings API in the category, including completed
  listings. Needs an app key.
- Daily scheduled crawl, which is what turns price history from a schema into a dataset.
- Battery health for used EVs via Recurrent, which is to an EV what mileage is to a combustion car.
