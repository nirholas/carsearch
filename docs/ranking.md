# Ranking: asking for two things at once

Most search UIs give you one sort column. That answers "the cheapest one" and
"the lowest-mileage one", and it cannot answer the question people actually ask,
which is some version of:

> a 2017 Macan, lowest miles I can get, without paying stupid money

Those are two objectives pulling against each other. There is no column that
expresses the trade-off, so carsearch computes the ordering rather than
delegating it to SQL.

## Two mechanisms

### 1. The Pareto frontier ("BEST OF BOTH")

A car is **undominated** when nothing else in the result set beats it on every
dimension you ranked by, at once. That set is the frontier, and it is the exact,
weighting-free answer to "lowest mileage and lowest price": inside it you cannot
improve one without giving up the other, and everything outside it is strictly
worse than something inside it.

It needs no arbitrary weights to be true, which is why it outranks the score.
Cards on the frontier are badged `BEST OF BOTH`.

A worked example, real data from the index:

```
$22,590  40,048 mi   #6 lowest mileage, #3 lowest price   <- best trade-off
$25,493  34,169 mi   #3 lowest mileage, #12 lowest price
$21,950  57,000 mi   #14 lowest mileage, #2 lowest price
$27,998  32,638 mi   #1 lowest mileage, #19 lowest price  <- the low-miles extreme
$21,430  68,075 mi   #22 lowest mileage, #1 lowest price  <- the cheap extreme
```

Every one of those is on the frontier. Nothing in the other 20 results beats any
of them on both axes. A car asking $30,000 with 60,000 miles is not shown near
the top, because the $21,950 / 57,000-mile car beats it on both.

Behind the frontier, layer 2 is the frontier of what remains, and so on, up to
six layers. Past that the layer number stops meaning anything to a reader, so
rows are left unlabelled rather than given a number nobody can use.

### 2. The blended score

The frontier gives you a set, not an order within it. For that, each dimension
is converted to a **percentile within the result set** and the percentiles are
averaged with weights.

Percentiles, not raw values, for two reasons: the units are incomparable
(dollars against miles), and one $400,000 outlier would otherwise flatten the
entire price axis so that every ordinary car scored identically.

Ties share a percentile, so two identical cars can never be separated by a
tiebreak the user would read as meaningful.

**A missing value scores worst, never best.** A car with no published mileage
must not win a lowest-mileage sort by having nothing to show. The card says
`no mileage stated` so the blindness is visible rather than flattering.

## The dimensions

| Key | Better | Reads as |
|---|---|---|
| `price` | low | Lowest price |
| `mileage` | low | Lowest mileage |
| `year` | high | Newest model year |
| `age` | low | Oldest model year |
| `listed` | high | Most recently listed |
| `days-on-market` | high | Longest on the market, where a seller is most likely to negotiate |
| `deal` | low | Furthest below what these actually sell for |

`deal` is the one no incumbent has, because it ranks against **completed sales**
rather than against other asking prices. See [rating.ts](../src/core/rating.ts).

## Writing a sort

Presets, by name:

```
price  mileage  year  age  newest  days-on-market  deal
mileage+price   value   best
```

Or an explicit blend, with optional weights:

```
/api/search?sort=mileage+price          equal weight
/api/search?sort=mileage:2+price:1      mileage counts double
/api/search?sort=mileage,price          a comma works, because people type one
```

An unrecognized key is dropped and reported in `sort.ignored` rather than
failing the request, so a typo in a shared URL degrades to a sensible ordering
instead of a 400.

## In plain English

The sentence box understands the same thing:

| You type | You get |
|---|---|
| `2017 porsche macan lowest mileage and cheapest` | `sort=mileage+price`, year pinned to 2017 |
| `cheapest with lowest miles` | `sort=mileage+price` |
| `best value macan` | `sort=value` |
| `911 longest on the market` | `sort=days-on-market` |
| `macan with low miles` | **a filter**, `mileageMax=40000`, not a sort |

That last row is the distinction the parser is careful about. "Low miles" is a
filter; "lowest miles" is a ranking. Reading the first as the second caps results
at 40,000 miles and hides most of what you asked to see ranked, while still
returning a page that looks perfectly reasonable. There is a test for it.

## Why ranking is not done in SQL

`/api/search` pulls a pool of up to 3,000 matching rows and ranks the whole pool
in memory, then pages it.

A percentile taken from rows SQL already truncated by a *different* ordering is a
percentile of the wrong population, and the answer would silently change with the
page size. The coarse SQL `ORDER BY` still matters, but only to decide which rows
survive the pool cap if it bites: it is set from the first requested dimension.

When the cap does bite, the response says so (`stats.poolTruncated`) and the UI
tells you to narrow the search rather than quietly ranking a slice.

## Files

- [src/core/rank.ts](../src/core/rank.ts) - percentiles, Pareto layers, scoring
- [src/core/rating.ts](../src/core/rating.ts) - the `deal` dimension
- [tests/rank.test.ts](../tests/rank.test.ts) - including the motivating example
- [src/nl/parse.ts](../src/nl/parse.ts) - `SORT_INTENTS`
