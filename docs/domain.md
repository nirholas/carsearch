# Domain research

Checked 2026-09-07 via RDAP (authoritative registry data, not a reseller search box), plus live fetches
and the Internet Archive CDX API.

## The headline: carsearch.com is dormant and its owner is asking for ideas

`carsearch.com` resolves. Its entire content is 26 lines of HTML:

> **Car Search**
> We are taking suggestions on how to make this site productive, and pay for itself. Any ideas, please contact us.

Registry facts:

| Field | Value |
|---|---|
| Created | 1996-09-20 (30 years old) |
| Expires | 2027-09-19 |
| Registrar | eNom, Inc. |
| Registrant | Privacy-redacted individual, New York, US |
| Status | clientTransferProhibited (normal registrar lock, not a dispute) |
| Last changed | 2026-08-21 |
| Archive.org | Continuously archived every year 1996 through 2026 |

Read that together: a private individual has held a two-word exact-match automotive .com since 1996,
has never built a business on it, keeps renewing it, and has published an open invitation for someone
to make it productive. There is no broker, no marketplace listing, and no asking price, which usually
means a direct approach is both possible and cheaper than a listed domain.

**This is the play.** An exact-match .com with a 30-year registration history removes the single biggest
weakness of every alternative below: permanently competing with a dead page for your own brand query.

Cost expectation: unlisted two-word .com domains in a commercial vertical typically settle in the low
five figures, and an owner with no revenue and a stated desire to make the asset productive is the
best possible negotiating position for a buyer. Treat any number here as an estimate until an offer
comes back. A revenue share or equity component is worth proposing given how they framed it.

Contact path: no email is published on the page. Route through the eNom WHOIS privacy relay or the
registrar's registrant contact form. A draft approach is at the bottom of this file.

## Verified availability, 2026-09-07

### Available

| Domain | Notes |
|---|---|
| **carsearch.co** | Best available option. Google treats .co as generic, not as Colombia, so there is no accidental geotargeting. Shortest and most .com-like. |
| carsearch.us | Geotargeted to the United States by Google, which helps US ranking marginally and actively hurts everywhere else. Only pick this if the product is US-only forever. |
| carsearch.me | Personal-project connotation. |
| carsearch.dev | Fine for the open-source project even if the product lives elsewhere. On the HSTS preload list, so HTTPS is mandatory, which is correct anyway. |
| carsearch.sh | Reads as a shell tool. Good for the CLI, wrong for a consumer product. |
| carsearch.site, .tools, .live, .link, .page | Available but all weaken trust and CTR. Skip. |
| usecarsearch.com, trycarsearch.com, carsearchhq.com, carsearchapp.com, opencarsearch.com | Prefix .com variants. A real .com at the cost of a longer, less memorable string. |

### Taken

carsearch.com (dormant, see above), .net, .org, .io, .ai, .app, .xyz, .pro, .one, .site*, .online,
.store, mycarsearch.com, carsearchai.com, carsearchengine.com, allcarsearch.com, getcarsearch.com,
searchcars.com, findcars.com.

The restricted automotive TLDs (.cars, .auto, .car) run several thousand dollars per year through
Cars Registry and are not worth it at any stage.

## What actually matters for SEO here

Google has stated repeatedly that new gTLDs carry no inherent ranking advantage or penalty, so .co
will not rank worse than .com on the merits. The real differences are:

1. **Type-in and CTR leakage.** Users default to .com. Launching on .co while a dead .com sits on the
   exact same string means a permanent share of your brand traffic lands on a stranger's blank page.
2. **Trust in the SERP.** .com still converts better on identical listings.
3. **Geotargeting.** .us and other true ccTLDs restrict you to one country. .co does not.

Point 1 is the whole argument for buying carsearch.com rather than settling.

## Recommendation

1. Approach the carsearch.com owner now. It costs nothing to ask, and the page is an open invitation.
2. Register **carsearch.co** today regardless, so the project ships without waiting on a negotiation,
   and so the string is not sniped while the conversation happens.
3. Register carsearch.dev alongside it for the open-source and documentation surface.
4. If the .com lands, 301 everything to it and keep .co as a permanent redirect.

## Update: .co is premium-priced, so the answer is a .com

Standard .co pricing is $15.76 to register and $31.20 to renew (Porkbun list, checked 2026-09-07).
A quote far above that means the registry has flagged `carsearch.co` as a premium name, which also
means the renewal stays elevated forever, not just year one. Not worth it.

The structural fact that settles this: **Verisign does not operate a premium tier for unregistered
.com names.** Every .com that RDAP reports as unregistered costs the same $11.08 per year. There is no
such guarantee on .co, .io, .ai, .dev or any other modern TLD, where the registry can and does price
individual strings into the thousands. So the cheap path is not a cheaper TLD, it is a .com that is
genuinely unregistered.

### Available .com options, verified against Verisign RDAP on 2026-09-07

All of these are $11.08/yr with no premium possible:

| Domain | Read |
|---|---|
| **opencarsearch.com** | Recommended. Self-explanatory modifier, true of the project, keeps `carsearch` contiguous, and remains useful after carsearch.com lands. |
| onecarsearch.com | Rejected. "One" refers to one-search-across-all-sources, but the reference is not self-evident and a name that needs explaining is a bad name. |
| searcheverycar.com | Most descriptive of the value proposition, but breaks up the `carsearch` keyword string. |
| findeverycar.com | Same trade-off. |
| carsearchhub.com, carsearchpro.com, carsearchhq.com, carsearchapp.com | Suffix filler. Dilutes the keyword and reads generic. |
| usecarsearch.com, trycarsearch.com | SaaS prefixes. Read as placeholders for a domain you do not own. |
| carlistingsearch.com | Accurate but clumsy. |

Taken, for the record: thecarsearch, carsearcher, carsearchtool, everycarsearch, anycarsearch,
usedcarsearch, searchallcars, searchusedcars, searchanycar, findanycar, everycarforsale,
allcarsforsale, vehiclesearch, autosearchengine, and every one-word alternative tested (carscan,
carsift, carsweep, carscope, carsonar, carseeker, carspotter, carcompass, caratlas, carpulse,
carbeacon, carlookup, carbrowse, carcanvas).

### Revised recommendation

1. Register **onecarsearch.com** at $11.08/yr. It is the product domain.
2. Add **opencarsearch.com** at $11.08/yr for the open-source home if you want the split.
3. The repository and package stay named `carsearch` regardless. The npm name and the GitHub name are
   both free and neither depends on the domain.
4. Keep the carsearch.com approach open. If it lands, 301 onecarsearch.com to it.

Skip carsearch.dev: Google Registry does operate a premium tier, so the $8.75 list price is not
guaranteed for this string, and it buys nothing a .com does not already give you.

## Considered and rejected: autocarsearch

Checked 2026-09-07.

1. **The .com is taken.** Registered 2004-08-30 through GoDaddy, renewed through 2027, currently
   serving a blank 200 response. That is a speculative hold, so acquiring it means an aftermarket
   negotiation, which is the exact cost that ruled out carsearch.co.
2. **"auto" cannibalizes the keyword rather than adding to it.** On the Trends index where
   "car search" is 100, "auto car search" scores 7. Nobody types it.
3. **"autocar" is an occupied entity.** Google autocomplete on `autocar` returns autocar trucks,
   autocare products, autocare near me. Autocar Trucks is a US manufacturer founded in 1897 and
   Autocar is a major UK motoring title. The string contains theirs, so it inherits their
   associations and muddies its own.
4. **It is redundant.** Auto means car. "AutoCarSearch" parses as "automobile car search", the
   keyword-stuffed pattern Google discounted in the 2012 EMD update and that users read as low trust.
5. Thirteen characters against nine.

Free on npm, on GitHub, and on every TLD except .com. None of that offsets a taken .com.

Auto-family .coms that are actually available, all weaker than the recommendation:
autolistingsearch.com, autosearchhub.com, carautosearch.com. Taken: autosearch.com, searchautos.com,
autofinder.com, autocarfinder.com, autosearchengine.com.

**Recommendation: opencarsearch.com at $11.08/yr as the placeholder, carsearch.com as the target.**

## Final decision: acquire carsearch.com

Cost constraint lifted, so the answer is the exact-match .com and nothing else. `carsearch.com` is the
single best domain this product can have: it matches the strongest phrase we can realistically own
("car search", index 100 against car marketplace 47, car finder 16, car listings 14), it carries a
continuous 1996-to-2026 registration and archive history, and its owner has published an open request
for someone to make it productive.

### Comparable sales (DNJournal public sales record, 2026 year to date)

| Domain | Price | Date |
|---|---|---|
| Dealer.ai | $100,000 | 2026 YTD |
| Car.co | $90,000 | 2026-08-26, via Atom.com |
| Joyride.ai | $72,000 | 2026 YTD |

Those are single-word premium strings, which sit above where a two-word .com in the same vertical
normally trades. Read them as a ceiling, not a target. The category is clearly liquid and automotive
names are moving at real money right now, which is useful context but also a reason to move before
someone else notices this one.

### Negotiating position

Do not name a price first. The domain is unlisted, has no broker, generates no revenue, and the owner
published "we are taking suggestions on how to make this site productive, and pay for itself." That is
not the language of someone who has valued the asset. Ask what they want and let them anchor. Naming a
number first against an unsophisticated seller only ever costs money.

If they have no number, offer a structured deal before a bigger cash number: a cash floor plus a small
revenue share or equity slice reads as generous, matches what they said they wanted, and often closes
below a straight cash sale.

### Do this

1. Send the outreach below today. No price in the first message.
2. Register **opencarsearch.com** ($11.08) the same day as insurance, so the build ships on a real
   domain and the string cannot be sniped while the negotiation runs. Chosen over onecarsearch.com
   because "one" needs explaining and a name that needs a footnote is a bad name, while "open" is
   self-evident, true of the project, and keeps `carsearch` contiguous. It also survives the
   acquisition as the permanent open-source and documentation home rather than becoming a dead
   redirect. Runner-up if you want zero-explanation clarity: searcheverycar.com.
3. Repository and npm package stay `carsearch` regardless of how the negotiation ends.

## Draft outreach (not sent)

> Subject: Your carsearch.com
>
> Hi,
>
> Your page at carsearch.com asks for suggestions on making the site productive. I am building exactly
> that: a search engine that aggregates car listings from marketplaces, dealer inventory, auctions and
> salvage yards into one search, deduplicated by VIN, with real price history.
>
> I would like to buy the domain outright, or discuss a revenue share or equity arrangement if you
> would rather keep a stake in what it becomes. Either works for me.
>
> If you are open to it, what would you want for it? I can move quickly and pay however is easiest
> for you, including escrow.
>
> Thanks,
> [name]
