# Car selling platforms: source list for an aggregator

A working inventory of places cars are listed for sale, organized so you can decide what to ingest first.
Personal-use aggregator reference. Domains are given so you can go straight to robots.txt / sitemaps / network tab.

## How to read the "access" column

- **API**: a documented, public or partner API returns listings as structured data.
- **Feed**: sitemaps, RSS, or a JSON endpoint the site's own frontend calls (usually the fastest legitimate path).
- **HTML**: server-rendered or hydrated pages, scrape-able, usually behind some bot defense.
- **Hard**: Cloudflare/PerimeterX/DataDome, aggressive rate limits, or login walls. Budget real effort or buy the data.

Practical ordering for a build: eBay Motors API first (it is the only large, free, fully documented listings API),
then Marketcheck or Auto.dev for the US dealer long tail (they already aggregate ~40M+ listings), then per-site
scrapers for the enthusiast auctions (small volume, high value, weak defenses), then everything else.

---

## 1. United States: mainstream marketplaces and classifieds

| Platform | Domain | Notes | Access |
|---|---|---|---|
| Autotrader | autotrader.com | Cox Automotive. Largest dealer inventory. | Hard (JSON endpoints exist) |
| Cars.com | cars.com | Dealer + private party. | Hard |
| CarGurus | cargurus.com | Deal ratings, price history, owns Autolist + CarOffer. | Hard |
| Edmunds | edmunds.com | Listings + appraisal. Public API retired 2021. | HTML |
| Kelley Blue Book | kbb.com | **Wired.** The same Cox inventory Autotrader refuses us, plus history flags and dated price history on every record. See below. | TLS + `__NEXT_DATA__` |
| TrueCar | truecar.com | Price-to-market, dealer network. | HTML |
| CarsDirect | carsdirect.com | Lead-gen + listings. | HTML |
| Autolist | autolist.com | CarGurus-owned aggregator, mobile-first. | HTML |
| iSeeCars | iseecars.com | Aggregator + analytics (VIN report, price drops). | HTML |
| AutoTempest | autotempest.com | Meta-search across CL, eBay, Cars.com, CarGurus, BaT. Study it. | HTML |
| SearchTempest | searchtempest.com | Craigslist + Facebook Marketplace multi-city search. | HTML |
| CoPilot | copilotsearch.com | App-first aggregator. | Hard |
| PrivateAuto | privateauto.com | P2P with escrow, e-sign, instant funds transfer. | HTML |
| CarEdge | caredge.com | Deal analysis + listings. | HTML |
| Autoweb / Autobytel | autoweb.com | Legacy lead network. | HTML |
| CarStory | carstory.com | Vast-owned listing data + widgets. | API (partner) |
| Carsforsale.com | carsforsale.com | Big independent-dealer long tail, weak defenses. | HTML |
| CarSoup | carsoup.com | Regional (upper Midwest). | HTML |
| Autotrader Classics | classics.autotrader.com | Collector arm. | HTML |
| CarBuzz / Motor1 marketplaces | various | Syndicated listing widgets, usually Marketcheck under the hood. | n/a |

### Why Kelley Blue Book is the most valuable source here

Two fields arrive with a KBB search result that no other site in this document
publishes on a listings page.

**`vhrPreview`** is a vehicle-history flag set, present on 37 of the first 37
records sampled and on 308 of 311 McLarens in the first real crawl:

```
["NO_SALVAGE_TITLE", "NO_ACCIDENTS_REPORTED", "ONE_OWNER"]
```

Before this source, `owners` sat near 1% coverage and `accidents` at 0%, because
that data lives behind a paid history report everywhere else. It is now the best
covered history field in the index.

The flags are read literally and never stretched:

| Flag | Becomes | Deliberately does NOT become |
|---|---|---|
| `ONE_OWNER` | `owners = 1` | |
| `NO_ONE_OWNER` | nothing | `owners = 2`. More than one, count unpublished. |
| `NO_ACCIDENTS_REPORTED` | `accidents = 0`, `accidentFree = true` | |
| `ACCIDENTS_REPORTED` | `accidentFree = false` | `accidents = 1`. Reported, count unpublished. |
| `NO_SALVAGE_TITLE` | nothing | `titleStatus = clean`. Not salvage still leaves rebuilt, flood and lemon open. |
| `FREE_REPORT` | nothing | It is a marketing badge, not a fact about the car. |

**`pricingHistory`** is a dated series of asking prices going back to the day the
car was listed, on roughly a third of records:

```
07.28.2026  $459,800
07.30.2026  $461,023
08.04.2026  $457,023
```

Everywhere else, price history can only be accumulated forward by observing the
same listing on two different crawls, so it starts empty and fills in over weeks.
These are seeded into `price_points` on first insert and read back like any other
observation. The final `Price Today` entry is dropped: the crawler records the
current price itself, with a timestamp it can vouch for.

Also carried: KBB's own Fair Purchase Price and this car's distance from it. Kept
in `raw`, never ranked on, for the same reason CarGurus' deal rating is. Holding
both lets a listing read "below KBB, still above what these actually sell for".

**The trap.** An unrecognised make or model slug does not 404. `/cars-for-sale/
used/norfolkkangaroo` answers **200 with a page of Ford Mustangs and Kia
Sorentos**. An adapter that trusted the URL it requested would file all of them
under the make it asked for, which is exactly how 159 Mustangs once entered this
index labelled `G-Class`. Every record is therefore read for its own make, and
off-make rows are dropped and counted, so a rotted slug reports zero rather than
quietly succeeding.

Build the index from it with `scripts/kbb-index.sh` (`MAKES="Porsche BMW" ./scripts/kbb-index.sh`).

## 2. United States: online retailers, "buy it online" and instant-offer buyers

Both sides matter for an aggregator: retailers are supply, instant-offer desks are your price floor / arbitrage signal.

| Platform | Domain | Role |
|---|---|---|
| Carvana | carvana.com | Retail + instant offer. Owns ADESA physical auctions. |
| CarMax | carmax.com | Retail + appraisal offer. Largest used retailer by units. |
| EchoPark (Sonic) | echopark.com | Retail. |
| Driveway (Lithia) | driveway.com | Retail + sell/trade. |
| AutoNation | autonation.com | Retail + "we'll buy your car". |
| Group 1 AcceleRide | acceleride.com | Retail. |
| Asbury Clicklane | clicklane.com | Retail. |
| Penske / CarShop | carshop.com | Retail. |
| Hertz Car Sales | hertzcarsales.com | Rental defleet. |
| Enterprise Car Sales | enterprisecarsales.com | Rental defleet. |
| Avis Car Sales | avis.com/en/car-sales | Rental defleet. |
| Sixt Car Sales | sixt.com/used-cars | Rental defleet. |
| U-Haul truck sales | uhaul.com/truck-sales | Box trucks / vans. |
| Peddle | peddle.com | Instant offer, any condition. |
| Wheelzy | wheelzy.com | Cash for cars. |
| CarBrain | carbrain.com | Damaged / non-running. |
| Junk Car Medics | junkcarmedics.com | Salvage buyer. |
| GiveMeTheVIN | givemethevin.com | Wholesale buyer, strong on higher-end. |
| RumbleOn | rumbleon.com | Powersports + cars. |
| Copart Direct | copartdirect.com | Consumer arm of Copart. |
| CarOffer | caroffer.com | CarGurus, dealer-to-dealer instant trade. |
| Kelley Blue Book ICO | kbb.com/instant-cash-offer | The canonical offer benchmark. |
| Vroom | vroom.com | E-commerce shut down Jan 2024; brand now finance/AI. Historical data only. |
| Shift | shift.com | Bankrupt 2023. Dead source. |

## 3. General classifieds and peer-to-peer

| Platform | Domain | Notes |
|---|---|---|
| Facebook Marketplace | facebook.com/marketplace | Biggest US private-party volume by far. Login-walled, hostile to automation. |
| Craigslist | craigslist.org | Still huge. Per-city subdomains, RSS on search results, no API, IP-sensitive. |
| eBay Motors | ebay.com/motors | Auctions + BIN. Has a real, free, documented Browse API. Start here. |
| OfferUp | offerup.com | Absorbed Letgo. Mobile API. |
| Nextdoor | nextdoor.com | Hyperlocal, small volume. |
| Bookoo | bookoo.com | Military-base adjacent communities. |
| Recycler | recycler.com | Legacy CA classifieds. |
| PennySaver | pennysaverusa.com | Legacy print/online. |
| VarageSale, 5miles | varagesale.com, 5miles.com | Marginal for cars, cheap to add. |

## 4. Enthusiast, collector and online auction houses

High-signal, low-volume, and mostly scrape-friendly. This is where price discovery for interesting cars happens.

| Platform | Domain | Notes |
|---|---|---|
| Bring a Trailer | bringatrailer.com | The benchmark. Public sold archive with full comment history. |
| Cars & Bids | carsandbids.com | Doug DeMuro, modern enthusiast cars. Clean JSON endpoints. |
| Hemmings | hemmings.com | Classifieds + online auctions, deep archive. |
| ClassicCars.com | classiccars.com | Plus AutoHunter auctions (autohunter.com). |
| PCARMARKET | pcarmarket.com | Porsche-heavy, plus DealerAuction. |
| Collecting Cars | collectingcars.com | UK-founded, now global. |
| The Market by Bonhams | themarket.bonhams.com | Online. |
| Hagerty Marketplace | marketplace.hagerty.com | Auctions + private sales; owns Broad Arrow. |
| Broad Arrow Auctions | broadarrowauctions.com | Live, high end. |
| RM Sotheby's | rmsothebys.com | Live + online, top of market. |
| Gooding & Company | goodingco.com | Live, blue chip. |
| Mecum | mecum.com | Volume king for Americana. |
| Barrett-Jackson | barrett-jackson.com | Live, televised. |
| Bonhams Cars | cars.bonhams.com | Live international. |
| Artcurial Motorcars | artcurial.com | Paris. |
| Iconic Auctioneers | iconicauctioneers.com | UK (formerly Silverstone Auctions). |
| Historics | historics.co.uk | UK. |
| H&H Classics | handh.co.uk | UK. |
| Car & Classic | carandclassic.com | UK/EU, huge classic classifieds + auctions. |
| Trade Classics | tradeclassics.com | UK online auctions. |
| Worldwide Auctioneers | worldwideauctioneers.com | US live. |
| GAA Classic Cars | gaaclassiccars.com | Greensboro NC. |
| Motorious | motorious.com | Listings + editorial. |
| Barn Finds | barnfinds.com | Classifieds + finds coverage. |
| OldCarOnline | oldcaronline.com | Long-tail classic classifieds. |
| SBX Cars | sbxcars.com | Supercar Blondie's auction platform. |
| Issimi | issimi.com | Curated collector. |
| LBI Limited | lbilimited.com | Curated collector dealer. |

## 5. Wholesale, dealer-only and salvage auctions

The real price backbone. Most need a dealer license, but many expose public search or have data partners.

| Platform | Domain | Notes |
|---|---|---|
| Manheim | manheim.com | Cox. Largest wholesale auction. MMR is the wholesale benchmark. |
| ADESA | adesa.com | Carvana-owned physical network. |
| OPENLANE | openlane.com | Formerly KAR digital (TradeRev, BacklotCars). |
| ACV Auctions | acvauctions.com | Dealer-to-dealer app-first, condition reports, has partner APIs. |
| Copart | copart.com | Salvage + clean title, public search, global. |
| IAA | iaai.com | RB Global. Salvage. |
| Ritchie Bros | rbauction.com | Fleet, heavy, commercial. |
| SmartAuction (Ally) | smartauction.ally.com | Lease returns. |
| America's Auto Auction | americasautoauction.com | Independent network (XLerate). |
| E Inc / EBlock | eblock.com | Canada/US digital wholesale. |
| AutoIMS | autoims.com | Consignor-side inventory system, feed-relevant. |
| SalvageBid | salvagebid.com | Copart/IAA broker. |
| AutoBidMaster | autobidmaster.com | Copart broker, public bidding. |
| SCA Auction | sca.auction | Salvage broker. |
| A Better Bid | abetterbid.com | Salvage broker. |
| Bid.Cars | bid.cars | Aggregates Copart + IAA. |
| Poctra | poctra.com | Archive of past salvage auction results. Excellent price-history source. |
| Repokar | repokar.com | Repos. |
| Stat.vin / Bidfax | stat.vin, bidfax.info | VIN-keyed auction history scrapers. |

## 6. Government, fleet and police auctions

| Platform | Domain |
|---|---|
| GSA Auctions | gsaauctions.gov |
| GovDeals | govdeals.com |
| Public Surplus | publicsurplus.com |
| Municibid | municibid.com |
| GovPlanet | govplanet.com |
| Allsurplus (Liquidity Services) | allsurplus.com |
| US Marshals / Treasury seizures | usmarshals.gov, treasury.gov/auctions |
| PropertyRoom (police) | propertyroom.com |

## 7. Luxury, exotic and specialty

| Platform | Domain |
|---|---|
| duPont Registry | dupontregistry.com |
| JamesEdition | jamesedition.com |
| Exotic Car Trader | exoticcartrader.com |
| Classic Driver | classicdriver.com |
| Romans International | romansinternational.com |
| Tom Hartley | tomhartley.com |
| Amari Supercars | amarisupercars.com |
| Gateway Classic Cars | gatewayclassiccars.com |
| Streetside Classics | streetsideclassics.com |
| RK Motors | rkmotors.com |
| Vanguard Motor Sales | vanguardmotorsales.com |
| Volo Auto Museum | volocars.com |
| Duncan Imports | duncanimports.com (JDM) |

## 8. EV-specific

| Platform | Domain | Notes |
|---|---|---|
| Tesla used inventory | tesla.com/inventory/used/m3 | Public JSON API on the inventory endpoint. Easy win. |
| Rivian R1 Shop | rivian.com/r1-shop | Used Rivian. |
| Polestar Pre-owned | polestar.com | |
| Lucid pre-owned | lucidmotors.com | |
| Find My Electric | findmyelectric.com | Tesla-focused P2P. |
| Only Used Tesla | onlyusedtesla.com | |
| Recurrent | recurrentauto.com | Battery health reports attached to listings. Differentiator for your aggregator. |
| EV auto | ev.auto | EV-only retailer. |
| Current Automotive | currentautomotive.com | EV-only dealer. |

## 9. OEM certified pre-owned inventory (each is its own searchable national index)

toyota.com/usedcars, honda.com/certified, ford.com (Ford Blue Advantage: fordblueadvantage.com), chevrolet.com/certified-pre-owned,
bmwusa.com/cpo, mbusa.com/certified, audiusa.com/certified, porsche.com/finder (Porsche Finder, worldwide, JSON-backed),
lexus.com/certified, acura.com/certified-pre-owned, subaru.com/certified, mazdausa.com/certified, hyundaiusa.com/certified,
kia.com/certified, nissanusa.com/certified, vw.com/certified, volvocars.com/us/certified, landroverusa.com/certified,
jaguarusa.com/approved, genesis.com/certified, jeep.com/certified, ram trucks, gmc, cadillac, buick, mitsubishicars.com,
alfaromeousa.com, maserati, ferrari.com/approved (Ferrari Approved), lamborghini.com/selezione, mclaren.com/qualified,
astonmartin.com/timeless, bentleymotors.com/certified, rolls-roycemotorcars.com/provenance.

Most run on the same handful of OEM inventory backends, so a scraper written for one often ports to a sibling brand.

## 10. Dealer groups and the platforms their sites run on

Recognizing the site platform lets you write one scraper for thousands of dealer sites. This is the cheapest way to get
long-tail independent inventory that never reaches Autotrader.

Platforms: Dealer.com (Cox), Dealer Inspire (CDK), DealerOn, Sincro (formerly DealerSocket/Cobalt), Dealer eProcess,
fusionZONE, eBizAutos, Dealer Spike, DealerFire, AutoRevo, Auto Manager (webManager), Carsforsale dealer sites,
Motorsport Network platforms, PixelMotion, Team Velocity, LotVantage syndication.

Groups worth ingesting directly: AutoNation, Lithia/Driveway, Penske, Group 1, Asbury, Sonic/EchoPark, Hendrick,
Ken Garff, Larry H. Miller, Morgan Auto, Napleton, Herb Chambers, Berkshire Hathaway Automotive, West Herr, Ourisman.

## 11. Adjacent vehicle types (same ingestion patterns, easy expansion)

Trader Interactive network: CycleTrader.com, RVTrader.com, CommercialTruckTrader.com, EquipmentTrader.com, ATVTrader.com,
SnowmobileTrader.com, PWCTrader.com, AeroTrader.com. Plus: TruckPaper.com, MachineryTrader.com, BoatTrader.com,
RVT.com, PPL Motorhomes, Lazydays, iRV2 classifieds, ThumperTalk, CycleTrader competitors (ChopperExchange, Motorcycles on Autotrader).

Lease takeover: Swapalease.com, LeaseTrader.com, LeaseBusters.com (Canada), QuitALease.com.

## 12. Canada

AutoTrader.ca, Kijiji Autos (kijiji.ca/b-cars-trucks), CarGurus.ca, CarPages.ca, AutoHebdo.net (QC), LesPAC.com,
Clutch.ca, Canada Drives (canadadrives.ca), Carpaydiem, Go Auto (goauto.ca), CarCostCanada.com, Openlane Canada,
EBlock, ADESA Canada, Impact Auto Auctions (impactauto.ca), Copart Canada, Facebook Marketplace CA.

## 13. United Kingdom and Ireland

| Platform | Domain | Notes |
|---|---|---|
| Auto Trader UK | autotrader.co.uk | Dominant. Hard defenses. |
| Motors.co.uk | motors.co.uk | Acquired the Cazoo brand and marketplace. |
| PistonHeads | pistonheads.com | Enthusiast classifieds. |
| Gumtree | gumtree.com/cars | Private party. |
| eBay UK Motors | ebay.co.uk/motors | Use the eBay API. |
| Cinch | cinch.co.uk | Online retailer. |
| Carwow | carwow.co.uk | New/used + Sell Your Car auction to dealers. |
| Heycar | heycar.co.uk | OEM-backed marketplace. |
| WeBuyAnyCar | webuyanycar.com | Instant offer benchmark. |
| Motorway | motorway.co.uk | Sell to dealer network by auction. |
| Dealer Auction | dealerauction.co.uk | Trade auctions (Auto Trader + Cox JV). |
| BCA | bca.co.uk | Largest UK wholesale auction. |
| Manheim UK | manheim.co.uk | Wholesale. |
| Aston Barclay | astonbarclay.net | Wholesale. |
| Copart UK | copart.co.uk | Salvage. |
| RAC Cars | raccars.co.uk | |
| Exchange and Mart | exchangeandmart.co.uk | |
| Desperate Seller | desperateseller.co.uk | |
| Arnold Clark | arnoldclark.com | Largest UK dealer group. |
| Evans Halshaw / Stratstone | evanshalshaw.com, stratstone.com | Pendragon group. |
| Big Motoring World | bigmotoringworld.co.uk | |
| Ireland: DoneDeal | donedeal.ie | Dominant IE. |
| Ireland: Carzone | carzone.ie | |
| Ireland: Adverts.ie | adverts.ie | |

## 14. Continental Europe

**Germany / Austria / Switzerland**: mobile.de, autoscout24.de (+ .at, .ch, .it, .nl, .be, .es, .fr, .lu, .pl), kleinanzeigen.de,
heycar.de, autohero.com (Auto1 retail), wirkaufendeinauto.de (Auto1 buying), auto1.com (dealer wholesale), carwow.de,
pkw.de, autoboerse.at, gebrauchtwagen.at, willhaben.at, comparis.ch, anibis.ch, tutti.ch, car4you.ch, autoricardo.ch.

**France**: lacentrale.fr, leboncoin.fr, aramisauto.com, paruvendu.fr, autoscout24.fr, elite-auto.fr, vpauto.fr, agencesautomobilieres.fr.

**Spain / Portugal**: coches.net, milanuncios.com, wallapop.com, autocasion.com, coches.com, clicars.com, flexicar.es,
standvirtual.com (PT), olx.pt, piscapisca.pt.

**Italy**: subito.it, autoscout24.it, automobile.it, quattroruote.it, bakeca.it, clickar.it (fleet remarketing).

**Benelux**: marktplaats.nl, autotrack.nl, gaspedaal.nl (aggregator worth studying), anwb.nl/auto, autoscout24.nl,
2dehands.be, 2ememain.be, gocar.be, autoscout24.be.

**Nordics**: blocket.se, bytbil.se, wayke.se, kvdcars.com (auction, SE), bilweb.se, finn.no (dominant NO), nettbil.no,
bilbasen.dk, dba.dk, bilhandel.dk, nettiauto.com (FI), tori.fi.

**Poland / CEE**: otomoto.pl, olx.pl, autoplac.pl, sauto.cz, tipcars.com, aaaauto.cz, autobazar.eu, autovit.ro,
olx.ro, bazos.sk/cz, hasznaltauto.hu, jofogas.hu, mobile.bg, cars.bg, index.hr/oglasi, avto.net (SI), polovniautomobili.com (RS),
auto24.ee, ss.com (LV), autoplius.lt, autogidas.lt.

**Greece / Cyprus / Turkey**: car.gr, autotriti.gr, bazaraki.com (CY), sahibinden.com (TR, dominant), arabam.com,
vavacars.com.tr, otokocikinciel.com.

**Russia / Ukraine / CIS**: auto.ru, avito.ru, drom.ru, am.ru, auto.ria.com (UA), rst.ua, kolesa.kz (KZ), av.by (BY).

## 15. Latin America

Kavak (kavak.com, MX/BR/AR/CL/CO/PE/TR), MercadoLibre autos (carros.mercadolibre.com.mx / .com.ar / .com.br),
seminuevos.com (MX), vivanuncios.com.mx, autocosmos.com (regional), soloautos.mx, webmotors.com.br (BR leader),
icarros.com.br, mobiauto.com.br, olx.com.br, karvi.com.ar (AR), deruedas.com.ar, autocosmos.com.ar,
chileautos.cl, yapo.cl, tucarro.com.co (CO), carroya.com, neoauto.com (PE), mercadolibre.com.pe, patiotuerca.com (EC),
tucarro.com.ve, encuentra24.com (CA/PA), clasificadosonline.com (PR).

## 16. Middle East and Africa

dubizzle.com (UAE, dominant), yallamotor.com, carswitch.com, sellanycar.com, emiratesauction.com, opensooq.com (regional),
haraj.com.sa, syarah.com (SA), motory.com, hatla2ee.com (EG), contactcars.com (EG), olx.com.eg, waseet.net (KW/JO),
q84sale.com (KW), boursa.com.

Africa: autotrader.co.za, cars.co.za, gumtree.co.za, webuycars.co.za (huge ZA auction house), carfind.co.za, surf4cars.co.za,
cars45.com (NG), jiji.ng, autochek.africa (multi-country), naijauto.com, tonaton.com (GH), jumia deals, jiji.co.ke,
mobile.co.ke, carsforsale.co.zw.

## 17. Asia-Pacific

**Japan**: goo-net.com (Proto, plus goo-net-exchange for export), carsensor.net (Recruit), autoc-one.jp, kakaku.com/kuruma,
Yahoo! Auctions (auctions.yahoo.co.jp), USS auctions (ussnet.co.jp, dealer only), TC-V (tc-v.com), beforward.jp,
sbtjapan.com, jdmexpo.com, japanpartner.com, autorec.co.jp. Japanese export brokers publish weekly
USS auction sheets, which are the best global source of used-JDM comps.

**Korea**: encar.com (SK Encar, dominant), kbchachacha.com, bobaedream.co.kr, carmanager.co.kr, chutcha.net.

**China**: autohome.com.cn, che168.com (Autohome used), yiche.com, guazi.com, renrenche.com, xin.com (Uxin),
dongchedi.com, 58.com/ganji.com.

**India**: cars24.com, spinny.com, cardekho.com, carwale.com, cartrade.com, olx.in, droom.in, truebil.com,
mahindrafirstchoice.com, marutisuzukitruevalue.com, bigboytoyz.com (luxury).

**Southeast Asia**: carsome.my (+ .id, .th, .sg), carro.co (+ .id, .th), mudah.my, carlist.my, wapcar.my,
sgcarmart.com (SG, dominant), carousell.sg, motorist.sg, oneshift.com, mobil123.com (ID), oto.com (ID/PH/IN),
olx.co.id, one2car.com (TH), chobrod.com (TH), taladrod.com (TH), philkotse.com (PH), autodeal.com.ph,
zigwheels.ph, tsikot.com, bonbanh.com (VN), chotot.com (VN), oto.com.vn, carmudi (multiple markets).

**South Asia**: pakwheels.com (PK, dominant), olx.com.pk, bikroy.com (BD), ikman.lk (LK), riyasewana.com (LK),
patpat.lk.

**Australia / New Zealand**: carsales.com.au (dominant, CAR Group), drive.com.au, carsguide.com.au,
autotrader.com.au, gumtree.com.au, facebook marketplace AU, cars24.com/au, carbar.com.au, carma.com.au,
easyauto123.com.au, pickles.com.au (auction), manheim.com.au, grays.com.au, slatteryauctions.com.au,
trademe.co.nz/motors (NZ dominant), autotrader.co.nz, turners.co.nz, needacar.co.nz.

## 18. Data providers, APIs and valuation sources

The build-vs-buy shortlist. If your goal is coverage rather than scraper maintenance, two or three of these replace
fifty scrapers.

| Source | Domain | What you get |
|---|---|---|
| eBay Browse API | developer.ebay.com | Free, documented, real-time listings incl. Motors. Best starting point. |
| Marketcheck | marketcheck.com | 40M+ US/CA listings, VIN history, price prediction, dealer data. Paid, has a free tier. |
| Auto.dev | auto.dev | Listings API + VIN decode, developer-friendly pricing. |
| CIS Automotive | cisautomotive.com | Listing and pricing analytics. |
| Cox Automotive / vAuto | coxautoinc.com | Manheim MMR, KBB values. Enterprise. |
| J.D. Power Valuation (NADA) | jdpower.com/business | Trade/retail books. |
| Black Book | blackbook.com | Wholesale values, residuals. |
| Carfax | carfax.com | History reports; also carfax.com/cars-for-sale listings. |
| AutoCheck (Experian) | autocheck.com | History + auction announcements. |
| NMVTIS | vehiclehistory.gov | Federal title/brand data, cheap via approved providers. |
| NHTSA vPIC | vpic.nhtsa.dot.gov/api | Free VIN decode. Use it before paying anyone. |
| NHTSA Recalls / Safety Ratings | api.nhtsa.gov | Free recalls, complaints, NCAP ratings. |
| EPA Fuel Economy | fueleconomy.gov/ws | Free MPG and specs by year/make/model. |
| VinAudit | vinaudit.com | Cheap history + market value API. |
| ClearVIN, EpicVIN | clearvin.com, epicvin.com | Auction photo history by VIN. |
| DataOne Software | dataonesoftware.com | VIN to trim/spec, the hard part of normalization. |
| Chrome Data | chromedata.com | OEM build data, the industry standard for trim decoding. |
| Poctra / Stat.vin / Bidfax | poctra.com | Past salvage auction sale prices by VIN. |
| Bright Data / Oxylabs / Apify | brightdata.com, apify.com | Prebuilt Cars.com, Autotrader, CarGurus, FB Marketplace scrapers and datasets. |
| RedBook | redbookasiapacific.com | AU/NZ valuations. |
| Glass's / Cap HPI | cap-hpi.co.uk | UK valuations and history. |
| Schwacke / DAT | schwacke.de, dat.de | German valuations. |
| Autovista | autovistagroup.com | Pan-EU valuations. |

## 19. Existing aggregators to study before you build

AutoTempest, SearchTempest, iSeeCars, Autolist, CoPilot, CarGurus (started as an aggregator), Gaspedaal.nl,
AutoUncle (autouncle.com, pan-EU aggregator, the closest thing to what you are describing), Carwow, Wheelscout,
Kelley Blue Book + Autotrader syndication, Cazana (acquired, now Percayso), Trovit Cars
(trovit.com/cars, a classified-ads aggregator with wide international coverage), Mitula/Nestoria family, Oodle,
ClassifiedAds.com.

Trovit and AutoUncle matter most: both already solved the multi-country ingestion and dedupe problem you are about to hit.

## 20. Build notes that save weeks

1. **Dedupe on VIN first, then on (year, make, model, trim, mileage, price, dealer geo) fuzzy hash.** The same car
   appears on Autotrader, Cars.com, CarGurus and the dealer's own site simultaneously. Without dedupe your counts lie.
2. **Trim normalization is the actual hard problem**, not fetching. Budget for Chrome Data or DataOne, or accept
   messy facets. NHTSA vPIC decodes VINs for free but is weak on trim.
3. **Track price history per listing.** Days-on-market and price drops are the highest-value derived signal and
   nobody gives them to you; you have to build them by snapshotting daily.
4. **Ingest sold data, not just active listings.** BaT, Cars & Bids, Copart archives (Poctra), and eBay completed
   listings give you real transaction prices. Active listings are asks, not comps.
5. **Respect robots.txt and rate limits, and prefer the JSON endpoints the sites' own frontends call** over HTML
   parsing. They are more stable, cheaper, and change less.
6. **Facebook Marketplace and Craigslist carry most private-party inventory in the US** and both punish automation.
   Plan for residential proxies or accept a gap there.
7. **Start narrow.** eBay API + Cars & Bids + BaT + Tesla inventory + Copart gets you a working aggregator in a
   weekend with zero scraping arms race, and covers auctions, enthusiast, EV, and salvage.

---

## 21. Prior art on GitHub (surveyed 2026-09-07)

Headline finding: **there is no popular, maintained open-source car aggregator.** The GitHub search API returns
nothing above ~50 stars for anything that aggregates listings. The space is hundreds of single-site scrapers,
most abandoned within a year of their last commit, plus vendor demo repos. Nobody has built the thing you are
describing and kept it alive, because per-site parsers rot every few months and a solo maintainer stops paying
that tax. Plan for parser rot as the main engineering cost, not for finding a base to fork.

### Closest to a real aggregator

| Repo | Stack | What it covers | Why look |
|---|---|---|---|
| Frojoe6969/usa-car-search | Python, MIT, pushed 2026-07 | CarGurus, Autotrader, Cars.com, Craigslist, Facebook, eBay, auto.dev; Telegram alerts | The closest match to your spec. Ships Docker, an eBay OAuth setup script, and an FB auth script, which are exactly the two auth flows you will otherwise reinvent. |
| QuinntyneBrown/CarSearch | .NET 9, no license, pushed 2026-03 | 40+ dealership sites in parallel via browser automation, aggregated markdown report | The dealer-site long-tail approach in practice. Read how it parallelizes browser workers. |
| equa1iser/CarGrab | FastAPI + Next.js 15, pushed 2026-05 | CarMax + Marketcheck | Clean modern reference architecture for API-first ingestion rather than scraping. |
| nylocaltech/ReCoupe | Node + Puppeteer + Postgres + node-cron, 2022 | Four sources, SQL comparison layer | Old but has the piece most repos skip: a schema and query layer for cross-site comparison. |
| drifterz28/bid-aggregator | JS, GPL-3.0, 2022 | Cars & Bids + Bring a Trailer | Tiny, but the auction-side dedupe logic is a starting point. |
| cwj1234567/carbot-web-scraper | C#, 2024 | eBay Motors, Cars & Bids, BaT | Same auction trio in .NET. |
| tolsadus/TeslaPricing | TS + React + Supabase + Node scrapers, 2026-08 | Multi-marketplace Tesla listings | Good example of a narrow vertical aggregator that actually shipped a frontend. |
| lambdv/autosearch | C#, 2025-11 | New Zealand listings | Small, but a non-US worked example. |
| bhowiebkr/toyota_tundra_tracker | Python, 2025-12 | Single-model tracking across sites | The "narrow slice, real users" pattern. |

### Per-site scrapers worth harvesting parsers from

- **Autotrader UK**: liudvikasakelis/autotrader-scraper (24 stars, 2019), suhailidrees/autotrader_scraper (2023, BS4),
  liamelgie/autotrader-scraper (JS), kurt213/scraper-auto-trader. **Autotrader CA**: jakubd/unofficial-autotrader-scraper.
- **Cars.com**: ansarialireza/cars.com-scraper, arisp8/cars-com-scraper, colmen-5/cars-scraper (2025-11, freshest).
- **Facebook Marketplace vehicles**: TanmayChhatbar/Facebook-Marketplace-Vehicle-Scraper,
  harmindersinghnijjar/fb-marketplace-smartproxy-scraper (proxy-based, the realistic approach),
  kevmaindev/Facebook-Marketplace_Scraper (2025-05), The-Digital-Flipper/fb-marketplace-vehicle-scraper (under-market deal finder),
  its-me-prash/fb-marketplace-analyzer (scam scoring + price comparison), danyk20/facebook-marketplace-scraper (no API key).
- **Craigslist**: owen-brooks/craigslist-car-finder (nation-wide), lienmeat/clcarstrucks,
  drdave-teaching/craigslist-scraper-cars-v2 (2025-11, teaching repo but current).
- **Bring a Trailer**: Elliotw44/BAT_DataGrabber (traverses the sold archive), gisturiz/BaT-Auction-Crawler,
  aaronalerander/BringATrailerWebScraper, KaledDahleh/bring-a-trailer-tracker.
- **Europe**: markmelnic/mobile-de-crawler and markmelnic/car-indexes-craper (mobile.de + autoscout24.ch + anibis.ch index
  enumeration, the clever part), lorenzoelia/autoscout24_scraping, vkresch/autoscout24-crawler (Scrapy),
  leonardcser/auto24-api, nadar/autoscout24 (PHP client for the actual AutoScout24 REST API),
  ynizon/leboncoin, krzysztofkobra/otomoto-scraper, kami4ka/{OtomotoScraper,GebrauchwagenScraper,AutoUncleScraper,
  GaspedaalScraper,TheParkingScraper,FinnScraper} (ScrapingAnt vendor demos, so vendor-locked, but they are current
  and cover exactly the EU aggregators worth copying).
- **Rest of world**: ridvansevik/arabam-com-scraper (TR), DinethWeerasinghe/AutoPriceLK (riyasewana, LK),
  dablon/car-listings-scraper (TuCarro + MercadoLibre, CO), Chang511/gta-dealer-scraper (CA dealers),
  Umesh1608/dealer-scrapper (FastAPI + React + Playwright dealer inventory).
- **Local tooling**: wmp1001/marketplace-scraper (Craigslist + FB into SQLite with KBB price lookup, macOS).

### Data and normalization libraries (the parts actually worth reusing)

| Repo | Stars | What |
|---|---|---|
| cardog-ai/corgi | 330 | TypeScript VIN decode + validation against a customized VPIC database, offline. The single highest-quality thing in this whole space. Use it instead of calling vPIC per listing. |
| ShaggyTech/nhtsa-api-wrapper | 41 | TS client for the NHTSA vPIC API. |
| samsullivandelgobbo/vPIC-dl | 24 | Scripts to migrate the vPIC database from MS SQL to Postgres/SQLite. Exactly what you need for local, fast, free VIN decoding at ingest scale. |
| Wal33D/nhtsa-vin-decoder | 21 | Java vPIC wrapper with offline WMI fallback. |
| davidpeckham/vpic-api | 10 | Python vPIC client. |
| richardARPANET/vehicle-makes | 6 | Up-to-date make/model reference data. |
| MarketcheckCarsInc/marketcheck_api_sdk_python | 3 | Official Marketcheck Python SDK (stale, 2018, but shows the API shape). |
| MarketcheckCarsInc/marketcheck_portal | 2 | A full working car search portal on top of the Marketcheck API. Fastest path to a demo. |
| berke009/ilan-analiz | 56 | Browser extension that scores Turkish used-car listings from the buyer's side (price position, mileage commentary). Good UX pattern to steal: analysis injected into the listing page rather than a separate site. |

### Scraping infrastructure to build on instead of writing your own

firecrawl/firecrawl (177k), unclecode/crawl4ai (81k), apify/crawlee (25k), gocolly/colly (25k),
ScrapeGraphAI/Scrapegraph-ai (30k), NaiboWang/EasySpider (44k, visual no-code). For cars specifically, the Apify
store has maintained actors for Facebook Marketplace vehicles, AutoScout24, Cars.com and dealer inventory,
which is cheaper than maintaining those four parsers yourself.

### What the survey implies for your build

1. **Do not look for a base to fork.** Nothing here is both broad and maintained. Take the per-site parsers as
   reference for selectors and endpoint discovery, write your own ingestion core.
2. **Reuse the boring parts that are solved well**: corgi or a local vPIC Postgres for VIN decode, crawlee or colly
   for fetch orchestration, Apify actors for the two or three sites with the worst bot defenses.
3. **The repos that survived longest are narrow** (one model, one country, one auction pair). Broad aggregators in
   this list are all abandoned. Start with one vertical you personally care about and expand only where the parser
   maintenance pays for itself.
