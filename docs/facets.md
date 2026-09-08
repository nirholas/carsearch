# Facets: filtering on everything a source publishes

35 attributes, defined once in [src/core/facets.ts](../src/core/facets.ts). That
one registry feeds the database columns, the query parser, the search form, the
coverage report and the natural-language layer. Adding a facet there makes it
filterable everywhere; there is no second list to keep in step, and both stores
migrate themselves on next boot.

## The attributes

**The car** - make, model, trim, generation (factory platform code from the VIN,
e.g. `Type 95B`), model year, price, mileage, body style.

**Title and history** - title status, previous owners, reported accidents, no
accidents reported, service records, prior use (personal, lease, fleet, rental,
commercial, taxi, driver education), imported, open safety recall.

**Mechanical** - transmission, drivetrain, fuel, engine, cylinders,
displacement, doors, seats.

**Efficiency** - MPG city, MPG highway, electric range, battery size.

**Colour** - exterior, interior.

**Seller** - seller type, manufacturer certified, dealer, dealer rating, location.

Title statuses, in ascending severity:
`clean, unknown, lien, bonded, hail, theft-recovery, rebuilt, salvage, flood,
lemon, junk, parts-only`.

## The hard part is honesty, not filtering

Most listings never publish most of these. A source that never states an owner
count leaves that column null on every one of its listings, and a naive
"1 owner" filter **silently deletes that entire source from the results while
looking like it merely narrowed them**.

Three mechanisms handle that, and they are the reason this document exists:

**1. `unknown` is a value, not an absence.** For title status especially.
Conflating "the site did not say" with "the site said clean" is the single most
expensive mistake in this category, so `unknown` is a first-class value in the
vocabulary and is never assumed to mean clean.

**2. Every control shows its real coverage.** `/api/facets` reports how many
rows in the current scope carry each attribute, so the form renders
*"412 of 2,259 state it (18%)"* under the control, and an attribute nothing
carries says *"nothing in the index states this yet"* rather than being offered
as though it works.

**3. Strict facets exclude unknowns, and say so.** A buyer who asks for a clean
title must not be shown cars whose title nobody recorded. A buyer who asks for
four doors would rather see the ones that never published a door count than lose
two thirds of the market to a missing field.

So each facet declares a `strict` flag, the default follows it, and the response
carries `stats.excludedForUnknown` naming every filter that is dropping rows for
silence rather than for failing the test. Any strict facet can be relaxed per
query with `<key>.unknown=1`, and the form offers that as a checkbox.

## The wire format

One parameter per constraint, named for the facet, so a search is a link a
person can read, edit and share:

```
?titleStatus=clean,rebuilt      an enum or text: any of these
?owners.max=1                   a numeric bound
?year=2017                      a bare number on a numeric facet is an exact match
?certified=true                 a boolean
?owners.unknown=1               keep rows that never stated it
```

An unrecognized key is ignored rather than failing the request.

Endpoints reserve the parameters they own. `/api/market?mileage=45000` means
*"value a car at 45,000 miles"*, and without that reservation it also filtered
the market down to cars whose odometer reads exactly 45,000, which returned no
asking prices at all while looking like an empty model rather than a bug.

## Where the values come from

| Source | Gives |
|---|---|
| NHTSA vPIC (free, VIN) | drivetrain, transmission, cylinders, displacement, doors, seats, engine, body class, fuel, assembly country |
| CarGurus tiles | drivetrain, transmission, engine, doors, both colours, MPG city/highway, EV range and battery, CPO, dealer and rating, feature list |
| Cars.com cards | drivetrain, body style, fuel, exterior colour, CPO, dealer |
| Listing text | title status, owner count, accident count, prior use, service records, CPO, and mileage from auction titles like `48k-Mile` |

**Title status, owner count and accident count are not on any search-results
page from these sources.** They are published on detail pages only. The parsers
exist and are tested; the crawler does not yet fetch a detail page per listing,
so coverage on those three is currently zero and the UI says so rather than
implying otherwise.

## Repairing bad values

The normal upsert writes facets with `COALESCE`, so a re-crawl can only add
detail and never erase it. That is right for the common case and wrong when a
*parser* was wrong: the bad value is already stored and COALESCE protects it
forever.

[`scripts/repair-facets.ts`](../scripts/repair-facets.ts) issues direct updates
for exactly that, and every repair names the defect it fixes. Run it with
`--dry-run` first.

## Files

- [src/core/facets.ts](../src/core/facets.ts) - the registry and the text parsers
- [src/store/filter.ts](../src/store/filter.ts) - predicates and the query format
- [src/store/columns.ts](../src/store/columns.ts) - column map, generated SQL, migrations
- [src/enrich/text-facets.ts](../src/enrich/text-facets.ts) - what listing text yields
- [scripts/backfill-facets.ts](../scripts/backfill-facets.ts) - fills them from data already held
