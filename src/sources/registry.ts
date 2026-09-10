import type { Source, SourceCategory, SourceStatus, Transport, AccessMethod, PriceKind } from '../core/types.js';

/**
 * The registry of every place a car is listed for sale that this project knows about.
 *
 * This file is deliberately larger than the set of adapters we have written. A
 * source recorded as `blocked` or `planned` is not clutter: it is the result of
 * a real test, and it stops the next person re-testing it blindly or assuming a
 * gap in coverage is an oversight. Reachability findings marked "tested" were
 * verified with a real headless Chromium session on 2026-09-07, not inferred
 * from documentation, and plain HTTP fetch and a real browser give completely
 * different answers in both directions.
 *
 * Full source inventory with regional breakdown: docs/sources.md
 */

interface Spec {
  id: string;
  name: string;
  homepage: string;
  category: SourceCategory;
  countries?: string[];
  status?: SourceStatus;
  transport?: Transport;
  access?: AccessMethod;
  priceKinds?: PriceKind[];
  reachableVia?: { sourceId: string; code: string };
  notes?: string;
}

const s = (spec: Spec): Source => ({
  countries: ['US'],
  status: 'planned',
  transport: 'browser',
  access: 'html',
  priceKinds: ['ask'],
  ...spec,
});

export const SOURCES: Source[] = [
  // ---------------------------------------------------------------------------
  // Aggregators. A meta-search is a reachability multiplier, not a competitor to
  // route around: one AutoTempest scrape reaches Carvana and TrueCar, both of
  // which refuse direct access, and every result tile names its origin site in
  // `data-backend-sitecode`.
  // ---------------------------------------------------------------------------
  s({ id: 'autotempest', name: 'AutoTempest', homepage: 'https://www.autotempest.com', category: 'aggregator',
      status: 'live', transport: 'browser', priceKinds: ['ask', 'bid'],
      notes: 'Tested: plain fetch 403, real Chromium 200 with full results. Results stream in per source asynchronously, so poll the result count until stable rather than using a fixed wait. Per-model queries return far more than one broad query because each model gets its own quota.' }),
  s({ id: 'searchtempest', name: 'SearchTempest', homepage: 'https://www.searchtempest.com', category: 'aggregator',
      notes: 'Craigslist and Facebook Marketplace multi-city search. The practical route into the two largest private-party pools.' }),
  s({ id: 'iseecars', name: 'iSeeCars', homepage: 'https://www.iseecars.com', category: 'aggregator' }),
  s({ id: 'autolist', name: 'Autolist', homepage: 'https://www.autolist.com', category: 'aggregator' }),
  s({ id: 'carstory', name: 'CarStory', homepage: 'https://www.carstory.com', category: 'aggregator', access: 'api', status: 'needs-credentials' }),

  // ---------------------------------------------------------------------------
  // US mainstream marketplaces
  // ---------------------------------------------------------------------------
  s({ id: 'carscom', name: 'Cars.com', homepage: 'https://www.cars.com', category: 'marketplace',
      status: 'live', transport: 'browser', access: 'jsonld',
      notes: 'A worked example of why the prober exists. On the morning of 2026-09-07 this source was INVERTED: plain fetch 200, real Chromium blocked. By that evening it had flipped to the normal arrangement, fetch 403 and browser 200 with JSON-LD present. Nothing in our code changed. A source declaration is a measurement with a timestamp, never a fact.' }),
  s({ id: 'cargurus', name: 'CarGurus', homepage: 'https://www.cargurus.com', category: 'marketplace',
      status: 'live', transport: 'browser', access: 'feed',
      notes: 'A Remix application that ships its whole search response as JSON on window.__remixContext. Never scrape the tiles: their class names are content-hashed and change every deploy, and the payload holds 24 listings where the DOM renders 21, with the VIN, exact mileage, trim, body type, drivetrain, colours, days on market and their own deal rating. Second source after CarMax that dedupes exactly by VIN. URLs need CarGurus make and model codes (Porsche m48, Macan d2261); the adapter learns all 121 of them at runtime from the same payload rather than carrying a table that would rot.' }),
  s({ id: 'kbb', name: 'Kelley Blue Book', homepage: 'https://www.kbb.com', category: 'marketplace',
      status: 'live', transport: 'tls', access: 'feed',
      notes: 'The richest search-results payload of any source here, and the answer to two coverage gaps that no other site could fill. Every record carries vhrPreview, a history-report flag set (ONE_OWNER, NO_ACCIDENTS_REPORTED, NO_SALVAGE_TITLE), present on 37 of 37 in the first sample: owners and accidents sat near zero coverage before this. Most records also carry pricingHistory, dated asking prices going back to listing day, which everywhere else can only be accumulated by observing a car twice. Cox Automotive, same parent as Autotrader, and images come from atcimages.kbb.com: this is largely the inventory Autotrader refuses us, through a door that is open. TLS transport only (plain fetch 403, browser unnecessary since it all ships in __NEXT_DATA__). The trap: an unrecognised make or model slug answers 200 with unrelated cars rather than 404, so the adapter reads each record own make and drops off-make rows.' }),
  s({ id: 'autotrader', name: 'Autotrader', homepage: 'https://www.autotrader.com', category: 'marketplace',
      status: 'blocked', transport: 'blocked',
      notes: "Re-measured twice on 2026-09-08. The first measurement saw HTTP 200 and recorded the block as lifted; that was wrong. The 200 is the block: the body is a 3.7KB 'page unavailable' shell carrying a reCAPTCHA, served identically to a plain fetch, a Chrome TLS fingerprint and a real Chromium. A 200 with no content is the most deceptive refusal there is, because every status check passes. Genuinely blocked to all three transports." }),
  s({ id: 'edmunds', name: 'Edmunds', homepage: 'https://www.edmunds.com', category: 'marketplace',
      status: 'blocked', transport: 'blocked', notes: 'Tested: serves an explicit block page to a real browser.' }),
  s({ id: 'carfax', name: 'Carfax', homepage: 'https://www.carfax.com', category: 'marketplace',
      status: 'blocked', transport: 'blocked', notes: 'Tested: 403 both transports. Also the dominant history-report vendor; see the data-api entries.' }),
  s({ id: 'truecar', name: 'TrueCar', homepage: 'https://www.truecar.com', category: 'marketplace',
      status: 'via-aggregator', transport: 'blocked', reachableVia: { sourceId: 'autotempest', code: 'tc' },
      notes: 'Tested: Akamai refuses both transports. Reached only through AutoTempest.' }),
  s({ id: 'carsforsale', name: 'Carsforsale.com', homepage: 'https://www.carsforsale.com', category: 'marketplace',
      status: 'blocked', transport: 'blocked', notes: 'Tested: 403 both transports, despite a reputation for weak defenses.' }),
  s({ id: 'carsoup', name: 'CarSoup', homepage: 'https://www.carsoup.com', category: 'marketplace' }),
  s({ id: 'privateauto', name: 'PrivateAuto', homepage: 'https://privateauto.com', category: 'marketplace',
      status: 'via-aggregator', reachableVia: { sourceId: 'autotempest', code: 'pa' }, notes: 'Peer to peer with escrow and e-sign.' }),
  s({ id: 'caredge', name: 'CarEdge', homepage: 'https://caredge.com', category: 'marketplace', notes: 'Shows out-the-door price rather than advertised price.' }),

  // ---------------------------------------------------------------------------
  // Online retailers. Also the price floor: what these desks will pay is the
  // number a seller is really choosing against.
  // ---------------------------------------------------------------------------
  s({ id: 'carmax', name: 'CarMax', homepage: 'https://www.carmax.com', category: 'retailer',
      status: 'live', transport: 'browser', access: 'jsonld',
      notes: 'The best free structured data of any source tested: one JSON-LD @type:Car block per vehicle INCLUDING VIN, which makes it the only source that dedupes exactly. Two traps: the page also embeds Car blocks for "similar vehicles" so filter on brand.name, and there is no stable per-car URL so link via /cars?search=<VIN>.' }),
  s({ id: 'carvana', name: 'Carvana', homepage: 'https://www.carvana.com', category: 'retailer',
      status: 'live', transport: 'fetch', reachableVia: { sourceId: 'autotempest', code: 'cv' },
      notes: "Wired 2026-09-08 over the TLS transport: 403 to a plain fetch AND to a real Chromium, 200 with a Chrome TLS fingerprint. The inventory is not fetched over XHR; it rides in the page's React Flight payload, which is why an endpoint hunt came back empty. Carries a VIN on every car plus trim, both colours, body style, fuel type, fuel economy and seating." }),
  s({ id: 'echopark', name: 'EchoPark', homepage: 'https://www.echopark.com', category: 'retailer',
      status: 'blocked', transport: 'blocked', notes: 'Tested: ERR_HTTP2_PROTOCOL_ERROR, a protocol-level failure rather than a bot block.' }),
  s({ id: 'autonation', name: 'AutoNation', homepage: 'https://www.autonation.com', category: 'dealer-group',
      status: 'blocked', transport: 'blocked',
      notes: 'Re-tested 2026-09-09 across all eleven impit profiles (six Chrome versions, three Firefox, two okhttp) plus plain fetch and Chromium: 403 to every one. Field notes from the carbide prototype reached it with curl_cffi under safari17_0, and impit ships no Safari profile at any version. So this is blocked by our toolchain rather than by the site, which is a different thing from unreachable and worth revisiting if a Safari-capable client is ever added.' }),
  s({ id: 'driveway', name: 'Driveway (Lithia)', homepage: 'https://www.driveway.com', category: 'dealer-group' }),
  s({ id: 'clicklane', name: 'Clicklane (Asbury)', homepage: 'https://www.clicklane.com', category: 'dealer-group' }),
  s({ id: 'acceleride', name: 'AcceleRide (Group 1)', homepage: 'https://www.acceleride.com', category: 'dealer-group' }),
  s({ id: 'hertzcarsales', name: 'Hertz Car Sales', homepage: 'https://www.hertzcarsales.com', category: 'retailer', notes: 'Rental defleet.' }),
  s({ id: 'enterprisecarsales', name: 'Enterprise Car Sales', homepage: 'https://www.enterprisecarsales.com', category: 'retailer', notes: 'Rental defleet.' }),

  // ---------------------------------------------------------------------------
  // Classifieds and peer to peer. Most US private-party volume lives here and
  // both of the big two punish automation.
  // ---------------------------------------------------------------------------
  s({ id: 'ebaymotors', name: 'eBay Motors', homepage: 'https://www.ebay.com/motors', category: 'marketplace',
      status: 'needs-credentials', transport: 'fetch', access: 'api', priceKinds: ['ask', 'bid', 'sold'],
      notes: 'The only large, free, fully documented listings API in the category, and it carries completed-listing data. Highest value per hour of work of any source here. Needs an app key from developer.ebay.com.' }),
  s({ id: 'craigslist', name: 'Craigslist', homepage: 'https://www.craigslist.org', category: 'classified',
      status: 'live', transport: 'fetch', access: 'jsonld',
      notes: 'Wired 2026-09-08. Every search page publishes its results as a schema.org ItemList, so no browser is needed: a plain request with a browser TLS fingerprint returns 337 items for one metro. Sharded per metro, so coverage is a function of how many subdomains are queried. The private-party supply every other aggregator link-outs to.' }),
  s({ id: 'facebookmarketplace', name: 'Facebook Marketplace', homepage: 'https://www.facebook.com/marketplace', category: 'classified',
      status: 'blocked', transport: 'blocked', notes: 'Largest US private-party pool by far, login-walled and hostile to automation. Honest gap until proxies or a paid actor are budgeted.' }),
  s({ id: 'offerup', name: 'OfferUp', homepage: 'https://offerup.com', category: 'classified' }),

  // ---------------------------------------------------------------------------
  // Enthusiast auctions. Low volume, high signal, weak defenses, and the only
  // free source of real transaction prices. This is the differentiator.
  // ---------------------------------------------------------------------------
  s({ id: 'bringatrailer', name: 'Bring a Trailer', homepage: 'https://bringatrailer.com', category: 'auction-enthusiast',
      status: 'live', transport: 'either', priceKinds: ['sold', 'bid'],
      notes: 'Re-probed 2026-09-07 evening: a plain fetch returns 235 price strings against the browser probe\'s 27, so the sold archive is server-rendered and reachable WITHOUT a browser. The adapter still drives a browser because paging past the first screen needs the "Show More" control, but a first-page sweep can run on the cheap transport. Sold and live cards are structurally different: on a sold card the .listing-card IS the anchor, the title is in an h3, and .item-results is unrendered so innerText returns empty and only textContent works. An extractor written against live cards silently returns zero sold records.' }),
  s({ id: 'carsandbids', name: 'Cars & Bids', homepage: 'https://carsandbids.com', category: 'auction-enthusiast',
      status: 'live', transport: 'browser', priceKinds: ['sold', 'bid'],
      notes: 'Tested: 200 to Chromium. Modern enthusiast cars, clean markup.' }),
  s({ id: 'pcarmarket', name: 'PCARMARKET', homepage: 'https://www.pcarmarket.com', category: 'auction-enthusiast',
      priceKinds: ['sold', 'bid'], notes: 'Wired 2026-09-08 over the TLS transport; the listings ride in the page payload, which is why an endpoint hunt found nothing and the first URL tried (/auction/) turned out to be their blog. /auctions/ gives live bids and /results/ gives completed sales, and a lot counts as sold only if it ended AND met its reserve. They also auction parts and memorabilia, which the non-vehicle filter catches.', status: 'live', transport: 'fetch'}),
  s({ id: 'hemmings', name: 'Hemmings', homepage: 'https://www.hemmings.com', category: 'auction-enthusiast',
      status: 'live', transport: 'tls', access: 'html', priceKinds: ['ask', 'bid'],
      notes: 'Wired 2026-09-10 after being recorded blocked to all three transports, which it never was: the earlier test tried the bare chrome and firefox aliases and read two 403s as a wall. firefox133 answers 200 with 697KB, because the alias resolves to a build old enough to be fingerprinted. Rate limits hard, and that is the difficulty of the source rather than an aside: two requests twenty seconds apart both return a full page, the third returns a Cloudflare interstitial, and about ninety seconds of quiet clears it, so the adapter paces in tens of seconds and treats the interstitial as throttling to back off from. No payload to lift, the only JSON-LD is Organization and BreadcrumbList, so listings are read from anchored markup. Two markup traps: the anchors are split across lines, and an auction is /auction/ while a classified is /listing/, so keying on one silently drops half the page. Auction cards carry no price on the search page and are skipped rather than guessed at.' }),
  s({ id: 'classiccars', name: 'ClassicCars.com', homepage: 'https://classiccars.com', category: 'auction-enthusiast' }),
  s({ id: 'collectingcars', name: 'Collecting Cars', homepage: 'https://collectingcars.com', category: 'auction-enthusiast',
      countries: ['GB', 'US', 'AU'], priceKinds: ['sold', 'bid'], notes: "Probed 2026-09-08. Reachable with a Chrome TLS fingerprint (403 to plain fetch). Its frontend searches a Typesense index at dora.production.collecting.com/multi_search, which returns current bid, sold price and buy-now as separate fields plus mileage, fuel and transmission per lot: an unusually good payload. The adapter is written (sources/collectingcars.ts) but every request shape tried returns 401, most likely because the scoped key names a collection other than the guessed 'auctions'. Capture the real request body to settle it."}),
  s({ id: 'hagertymarketplace', name: 'Hagerty Marketplace', homepage: 'https://www.hagerty.com/marketplace', category: 'auction-enthusiast', priceKinds: ['sold', 'bid'],
      status: 'live', transport: 'fetch', access: 'feed',
      notes: 'Wired 2026-09-08 over the TLS transport. Their money fields are integer CENTS: a 1963 356B carrying amount 12500000 is $125,000, and reading it as dollars would have put a fictional eight-figure car into the collector cohort. Thin so far: the landing page exposes only ten to fifteen live lots, and no URL has been found that lists completed sales, which is the half worth having. marketplace.hagerty.com does not resolve; the working host is www.hagerty.com/marketplace.' }),
  s({ id: 'mecum', name: 'Mecum', homepage: 'https://www.mecum.com', category: 'auction-enthusiast', priceKinds: ['sold'] }),
  s({ id: 'barrettjackson', name: 'Barrett-Jackson', homepage: 'https://www.barrett-jackson.com', category: 'auction-enthusiast', priceKinds: ['sold'] }),
  s({ id: 'rmsothebys', name: "RM Sotheby's", homepage: 'https://rmsothebys.com', category: 'auction-enthusiast', priceKinds: ['sold'] }),
  s({ id: 'goodingco', name: 'Gooding & Company', homepage: 'https://www.goodingco.com', category: 'auction-enthusiast', priceKinds: ['sold'] }),
  s({ id: 'broadarrow', name: 'Broad Arrow Auctions', homepage: 'https://www.broadarrowauctions.com', category: 'auction-enthusiast', priceKinds: ['sold'] }),
  s({ id: 'bonhamscars', name: 'Bonhams Cars', homepage: 'https://cars.bonhams.com', category: 'auction-enthusiast', countries: ['GB', 'US'], priceKinds: ['sold'] }),
  s({ id: 'carandclassic', name: 'Car & Classic', homepage: 'https://www.carandclassic.com', category: 'auction-enthusiast', countries: ['GB'], priceKinds: ['ask', 'sold'] }),

  // ---------------------------------------------------------------------------
  // Wholesale and salvage. The wholesale price is what sets every retail price
  // above it, and the salvage archives are a free per-VIN price history.
  // ---------------------------------------------------------------------------
  s({ id: 'copart', name: 'Copart', homepage: 'https://www.copart.com', category: 'auction-salvage',
      countries: ['US', 'CA', 'GB', 'DE'], status: 'live', transport: 'fetch', priceKinds: ['bid', 'sold'],
      notes: 'Wired 2026-09-08 against POST /public/lots/search-results over the TLS transport. The block recorded here was wrong twice over: the service answers a POST and returns 405 to anything else, and the transport was quietly sending GETs because its request options went to the client constructor, so a wrong verb read as a wrong path. The only source found so far that states a title brand on EVERY lot, plus damage description and whether the odometer reading is believed.' }),
  s({ id: 'iaai', name: 'IAA', homepage: 'https://www.iaai.com', category: 'auction-salvage', priceKinds: ['bid', 'sold'] }),
  s({ id: 'poctra', name: 'Poctra', homepage: 'https://poctra.com', category: 'auction-salvage', priceKinds: ['sold'],
      notes: 'Archive of past salvage auction results keyed by VIN. One of the few free sources of historical transaction prices.' }),
  s({ id: 'manheim', name: 'Manheim', homepage: 'https://www.manheim.com', category: 'auction-wholesale',
      status: 'needs-credentials', priceKinds: ['sold'], notes: 'MMR is the wholesale benchmark the whole industry prices against. Dealer licence required.' }),
  s({ id: 'acvauctions', name: 'ACV Auctions', homepage: 'https://www.acvauctions.com', category: 'auction-wholesale',
      status: 'needs-credentials', access: 'api', priceKinds: ['sold'] }),
  s({ id: 'openlane', name: 'OPENLANE', homepage: 'https://www.openlane.com', category: 'auction-wholesale', status: 'needs-credentials', priceKinds: ['sold'] }),

  // ---------------------------------------------------------------------------
  // Government and fleet. Public by law, so rarely defended.
  // ---------------------------------------------------------------------------
  s({ id: 'govdeals', name: 'GovDeals', homepage: 'https://www.govdeals.com', category: 'auction-government', priceKinds: ['bid', 'sold'] }),
  s({ id: 'gsaauctions', name: 'GSA Auctions', homepage: 'https://gsaauctions.gov', category: 'auction-government', priceKinds: ['bid', 'sold'] }),
  s({ id: 'publicsurplus', name: 'Public Surplus', homepage: 'https://www.publicsurplus.com', category: 'auction-government', priceKinds: ['bid', 'sold'] }),
  s({ id: 'municibid', name: 'Municibid', homepage: 'https://municibid.com', category: 'auction-government', priceKinds: ['bid', 'sold'] }),

  // ---------------------------------------------------------------------------
  // EV. Battery health is to an EV what mileage is to a combustion car, and
  // nobody surfaces it next to a listing.
  // ---------------------------------------------------------------------------
  s({ id: 'tesla', name: 'Tesla Used Inventory', homepage: 'https://www.tesla.com/inventory/used/m3', category: 'ev',
      status: 'blocked', transport: 'blocked', access: 'feed',
      notes: 'The inventory JSON endpoint takes no key, but it returns 403 to both transports from a datacenter IP. This is an IP reputation block rather than a bot-detection block, so it will work from a residential address and fail from any cloud runner. Recorded honestly rather than left looking broken.' }),
  s({ id: 'rivian', name: 'Rivian R1 Shop', homepage: 'https://rivian.com/r1-shop', category: 'ev' }),
  s({ id: 'recurrent', name: 'Recurrent', homepage: 'https://www.recurrentauto.com', category: 'ev',
      notes: 'Battery health reports attached to listings. The differentiating enrichment for used EVs.' }),

  // ---------------------------------------------------------------------------
  // OEM certified pre-owned. Sibling brands share inventory backends, so one
  // adapter usually ports across several marques.
  // ---------------------------------------------------------------------------
  s({ id: 'porschefinder', name: 'Porsche Finder', homepage: 'https://finder.porsche.com', category: 'oem',
      countries: ['GLOBAL'], access: 'feed',
      notes: 'Tested: 429 rather than 403, so it is rate limiting and not blocking. Needs backoff, not evasion. JSON-backed and the backend is shared across several OEM finders.' }),
  s({ id: 'fordblueadvantage', name: 'Ford Blue Advantage', homepage: 'https://www.fordblueadvantage.com', category: 'oem' }),
  s({ id: 'mbusacpo', name: 'Mercedes-Benz Certified', homepage: 'https://www.mbusa.com/en/certified-pre-owned', category: 'oem' }),
  s({ id: 'bmwusacpo', name: 'BMW Certified', homepage: 'https://www.bmwusa.com/certified-pre-owned.html', category: 'oem' }),

  // ---------------------------------------------------------------------------
  // Specialty and exotic
  // ---------------------------------------------------------------------------
  s({ id: 'dupontregistry', name: 'duPont Registry', homepage: 'https://www.dupontregistry.com', category: 'specialty',
      status: 'live', transport: 'fetch', access: 'feed',
      notes: 'Wired 2026-09-08 over the TLS transport; another Next.js App Router site whose inventory rides in the React Flight payload rather than in an XHR. Carries a real VIN per car, so it dedupes against the mainstream sources. Two traps: a price of 0 means "price on request" and must never enter a median, and their results URL does not narrow the payload, so naming a make in it buys nothing and this source is best crawled broadly.' }),
  s({ id: 'jamesedition', name: 'JamesEdition', homepage: 'https://www.jamesedition.com/cars', category: 'specialty', countries: ['GLOBAL'] }),
  s({ id: 'jdpower', name: 'J.D. Power', homepage: 'https://www.jdpower.com', category: 'marketplace',
      status: 'blocked', transport: 'blocked',
      notes: 'Tested 2026-09-08: 403 to a plain fetch on every listings URL shape tried, and 404 with a Next.js flight payload over the TLS transport, meaning the paths guessed do not exist rather than being defended. Primarily a valuation brand whose listings are syndicated from elsewhere, so it duplicates inventory the index already has. Low value even if opened.' }),
  s({ id: 'exoticcartrader', name: 'Exotic Car Trader', homepage: 'https://www.exoticcartrader.com', category: 'specialty',
      status: 'planned', transport: 'fetch', access: 'html',
      notes: 'Tested 2026-09-08: open to a plain fetch, no defenses. Two findings for whoever wires it. The filter is a PATH, not a query: /cars-for-sale/mclaren works and /cars-for-sale?make=McLaren is silently ignored, returning the generic page with three featured cars. And there is no payload to extract: server-rendered Webflow plus htmx, no JSON-LD, no embedded state, so this is genuine HTML parsing. Volume is small (6 McLarens against 311 on KBB), which is why it sits behind bigger sources despite being trivially reachable.' }),
  s({ id: 'classicdriver', name: 'Classic Driver', homepage: 'https://www.classicdriver.com', category: 'specialty', countries: ['GLOBAL'] }),

  // ---------------------------------------------------------------------------
  // International. See docs/sources.md for the full per-country inventory; these
  // are the dominant sites in each market, which is where an adapter pays off.
  // ---------------------------------------------------------------------------
  s({ id: 'autotraderuk', name: 'Auto Trader UK', homepage: 'https://www.autotrader.co.uk', category: 'marketplace', countries: ['GB'] }),
  s({ id: 'pistonheads', name: 'PistonHeads', homepage: 'https://www.pistonheads.com', category: 'marketplace', countries: ['GB'] }),
  s({ id: 'mobilede', name: 'mobile.de', homepage: 'https://www.mobile.de', category: 'marketplace', countries: ['DE'] }),
  s({ id: 'autoscout24', name: 'AutoScout24', homepage: 'https://www.autoscout24.com', category: 'marketplace',
      countries: ['DE', 'AT', 'CH', 'IT', 'NL', 'BE', 'ES', 'FR'], access: 'jsonld',
      notes: 'Wired 2026-09-08 through the shared schema.org adapter (sources/jsonld-marketplace.ts). Reachable with a browser TLS fingerprint. Its Car ItemList sits under mainEntity, so it read as having no structured data at all until the JSON-LD reader learned to descend into wrappers; that one fix unlocked this, Finn.no and Blocket together. Odometer readings are tagged KMT and converted to miles. Prices stay in EUR and are never converted.', status: 'live', transport: 'fetch'}),
  s({ id: 'lacentrale', name: 'La Centrale', homepage: 'https://www.lacentrale.fr', category: 'marketplace', countries: ['FR'] }),
  s({ id: 'leboncoin', name: 'Leboncoin', homepage: 'https://www.leboncoin.fr', category: 'classified', countries: ['FR'] }),
  s({ id: 'cochesnet', name: 'Coches.net', homepage: 'https://www.coches.net', category: 'marketplace', countries: ['ES'] }),
  s({ id: 'subito', name: 'Subito', homepage: 'https://www.subito.it', category: 'classified', countries: ['IT'] }),
  s({ id: 'marktplaats', name: 'Marktplaats', homepage: 'https://www.marktplaats.nl', category: 'classified', countries: ['NL'] }),
  s({ id: 'otomoto', name: 'Otomoto', homepage: 'https://www.otomoto.pl', category: 'marketplace', countries: ['PL'] }),
  s({ id: 'blocket', name: 'Blocket', homepage: 'https://www.blocket.se', category: 'classified', countries: ['SE'], status: 'live', transport: 'fetch', access: 'jsonld', notes: 'Wired 2026-09-08 through the shared schema.org adapter. Prices in SEK, same caveat as Finn.no about their search not filtering by make.'}),
  s({ id: 'finnno', name: 'Finn.no', homepage: 'https://www.finn.no/mobility', category: 'marketplace', countries: ['NO'], status: 'live', transport: 'fetch', access: 'jsonld', notes: "Wired 2026-09-08 through the shared schema.org adapter. Prices are in NOK and stay there: converting would bake today's rate into a permanent record. Its search is not narrowed by a make in the URL without a numeric id we do not hold, so it is crawled broadly and every row keeps whatever brand it declares."}),
  s({ id: 'mobilebg', name: 'Mobile.bg', homepage: 'https://www.mobile.bg', category: 'marketplace', countries: ['BG'] }),
  s({ id: 'sahibinden', name: 'Sahibinden', homepage: 'https://www.sahibinden.com', category: 'classified', countries: ['TR'] }),
  s({ id: 'autotraderca', name: 'AutoTrader.ca', homepage: 'https://www.autotrader.ca', category: 'marketplace', countries: ['CA'] }),
  s({ id: 'kijijiautos', name: 'Kijiji Autos', homepage: 'https://www.kijijiautos.ca', category: 'classified', countries: ['CA'] }),
  s({ id: 'carsalesau', name: 'Carsales', homepage: 'https://www.carsales.com.au', category: 'marketplace', countries: ['AU'] }),
  s({ id: 'trademe', name: 'Trade Me Motors', homepage: 'https://www.trademe.co.nz/motors', category: 'marketplace', countries: ['NZ'], access: 'api' }),
  s({ id: 'goonet', name: 'Goo-net', homepage: 'https://www.goo-net.com', category: 'marketplace', countries: ['JP'] }),
  s({ id: 'carsensor', name: 'Carsensor', homepage: 'https://www.carsensor.net', category: 'marketplace', countries: ['JP'] }),
  s({ id: 'encar', name: 'Encar', homepage: 'https://www.encar.com', category: 'marketplace', countries: ['KR'] }),
  s({ id: 'cars24', name: 'Cars24', homepage: 'https://www.cars24.com', category: 'retailer', countries: ['IN', 'AE', 'AU'] }),
  s({ id: 'carsome', name: 'Carsome', homepage: 'https://www.carsome.my', category: 'retailer', countries: ['MY', 'ID', 'TH', 'SG'] }),
  s({ id: 'sgcarmart', name: 'SgCarMart', homepage: 'https://www.sgcarmart.com', category: 'marketplace', countries: ['SG'] }),
  s({ id: 'pakwheels', name: 'PakWheels', homepage: 'https://www.pakwheels.com', category: 'marketplace', countries: ['PK'] }),
  s({ id: 'dubizzle', name: 'Dubizzle', homepage: 'https://uae.dubizzle.com/motors', category: 'classified', countries: ['AE'] }),
  s({ id: 'kavak', name: 'Kavak', homepage: 'https://www.kavak.com', category: 'retailer', countries: ['MX', 'BR', 'AR', 'CL', 'CO'] }),
  s({ id: 'webmotors', name: 'Webmotors', homepage: 'https://www.webmotors.com.br', category: 'marketplace', countries: ['BR'] }),
  s({ id: 'mercadolibreautos', name: 'MercadoLibre Autos', homepage: 'https://autos.mercadolibre.com.mx', category: 'marketplace', countries: ['MX', 'AR', 'BR'] }),
  s({ id: 'autotraderza', name: 'AutoTrader South Africa', homepage: 'https://www.autotrader.co.za', category: 'marketplace', countries: ['ZA'] }),

  // ---------------------------------------------------------------------------
  // Data and enrichment APIs. Free government endpoints first: they solve trim
  // normalization, which is the genuinely hard problem, at zero cost.
  // ---------------------------------------------------------------------------
  s({ id: 'vpic', name: 'NHTSA vPIC', homepage: 'https://vpic.nhtsa.dot.gov/api', category: 'data-api',
      status: 'live', transport: 'either', access: 'api', priceKinds: [],
      notes: 'Verified reachable 2026-09-07 on both transports. Free, no key, no rate limit observed. Decodes a VIN to year, make, model, trim, body class and engine, and crucially returns Series, the factory platform code (Type 95B, 991 vs 992, 981 vs 982). That is generation-accurate normalization for free, and generation is the axis that actually moves price.' }),
  s({ id: 'nhtsa-recalls', name: 'NHTSA Recalls', homepage: 'https://api.nhtsa.gov', category: 'data-api',
      status: 'live', transport: 'either', access: 'api', priceKinds: [],
      notes: 'Verified reachable 2026-09-07 on both transports. Free, no key. Returns campaign number, component, summary, and parkIt / parkOutSide booleans for fire-risk campaigns. Showing an open do-not-park recall next to a listing is something no incumbent does.' }),
  s({ id: 'fueleconomy', name: 'EPA Fuel Economy', homepage: 'https://www.fueleconomy.gov/ws', category: 'data-api',
      transport: 'fetch', access: 'api', priceKinds: [],
      notes: 'Free. Coverage is patchy on EVs and exotics: verified empty for the Porsche Taycan. Check per segment before relying on it.' }),
  s({ id: 'marketcheck', name: 'Marketcheck', homepage: 'https://www.marketcheck.com', category: 'data-api',
      status: 'needs-credentials', transport: 'fetch', access: 'api',
      notes: 'Around 40 million US and CA listings behind one API, with a free tier. Replaces the entire dealer long tail if coverage matters more than scraper maintenance.' }),
  s({ id: 'autodev', name: 'Auto.dev', homepage: 'https://auto.dev', category: 'data-api',
      status: 'needs-credentials', transport: 'fetch', access: 'api' }),
];

const byId = new Map(SOURCES.map((x) => [x.id, x]));

export function getSource(id: string): Source | undefined {
  return byId.get(id);
}

export function sourcesByStatus(status: SourceStatus): Source[] {
  return SOURCES.filter((x) => x.status === status);
}

export function liveSources(): Source[] {
  return SOURCES.filter((x) => x.status === 'live');
}

export function registryStats() {
  const by = <K extends keyof Source>(k: K) =>
    SOURCES.reduce<Record<string, number>>((acc, x) => {
      const v = String(x[k]);
      acc[v] = (acc[v] ?? 0) + 1;
      return acc;
    }, {});
  return {
    total: SOURCES.length,
    byStatus: by('status'),
    byCategory: by('category'),
    byTransport: by('transport'),
    countries: [...new Set(SOURCES.flatMap((x) => x.countries))].sort(),
  };
}
