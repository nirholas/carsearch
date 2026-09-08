# Market data: the dashboard, the valuation and the backtest

`/#/dashboard` and `/api/market` answer the question a listing page cannot:
**what is this model actually worth, and which way is it moving?**

Everything here that claims to be about *value* is computed from **completed
sales only**. Asking prices appear only where they are labelled as asks. Mixing
the two produces confident numbers that are wrong, and that is the defining
failure of this whole category: an index built from asking prices shows a market
that never falls, because sellers never mark themselves down in public.

## What it shows

**The headline strip**

| Stat | From |
|---|---|
| Median asking price | listings with `priceKind: 'ask'` |
| Median sold price | listings with `priceKind: 'sold'` |
| Sellers ask above market | the difference, and the percent |
| Value lost per 10,000 miles | the fitted depreciation curve |
| Market direction | the trend fit, **or "no clear direction"** |
| Days on market | observed `firstSeen` to `lastSeen` |

Real numbers from the index for a Porsche Macan: median ask **$35,556**, median
sold **$22,000**, spread **$13,556 (62%)**. That gap is the product.

**Asking prices against completed sales.** Two overlaid histograms. The distance
between the humps is the thing; a single median hides that the two populations
barely overlap.

**What mileage is worth.** Every completed sale as a point, with a curve fitted
through them. The fit is on `log(price)`, because depreciation is multiplicative:
a car does not lose the same number of dollars for its first 10,000 miles as for
its hundredth. That makes the model say *"loses 6% per 10k"*, which is both truer
to the shape and comparable between a $15,000 car and a $150,000 one.

**Sold prices over time.** Median per week or per month, with the interquartile
band shaded. **Point size is the number of sales behind it** - the size is the
caveat.

**By model year** and **by mileage band**, ask against sold.

**The backtest.** What a buyer at each past period's median would be sitting on
at today's median.

## The honesty rules, and why each exists

These are enforced in [analytics/stats.ts](../src/analytics/stats.ts) and
[analytics/market.ts](../src/analytics/market.ts), not left to the UI. A chart
library will happily draw a confident line through noise, and nobody looking at
the picture can tell.

**A slope that explains nothing is reported as flat.** Ten weeks of real sale
data routinely fits at r2 = 0.01, meaning the line explains one percent of what
prices did. Printing "up 10.9% a month" from that would be the most misleading
number on the page. Below r2 0.15 the trend reports `direction: 'flat'` and the
UI says *"prices move, the trend does not"*.

**A short window is not annualized.** Compounding a two-month window to a year
turns noise into a headline, so no annual figure is produced below a quarter.

**A per-year spread needs three sales.** One sale above every asking price is an
outlier, not a negative spread. Below three, the cell reads "needs 3 sales".

**A valuation refuses to extrapolate.** A curve fitted between 11,000 and 48,000
miles says nothing about a 190,000-mile car. Outside its range the response
carries `confidence: 'none'` and the page says the mileage is outside the data
rather than printing a number a buyer might act on.

**A repeated round mileage is a display placeholder, not an odometer.** CarMax
shows "1,000 mi" on every delivery-mileage car, so that exact value lands on
dozens of rows and would anchor the whole curve. The rule is repetition, not
roundness: excluding everything rounded to a thousand also threw away every
auction record whose title read "48k-Mile", which left the sold set with no
mileages and therefore no curve at all.

**Every median carries its sample size.** A median of four sales and a median of
four hundred look identical on a chart.

## Valuing one specific car

```
/api/market?make=Porsche&model=Macan&mileage=45000
```

returns, alongside the report:

```json
"valuation": {
  "price": 19588,
  "confidence": "weak",
  "extrapolatedBy": 0,
  "basis": "fitted on 5 completed sales between 11,000 and 48,000 miles (r2 0.69)"
},
"ownership": {
  "milesPerYear": 10000,
  "years": [ { "year": 1, "value": 14520, "lostThisYear": 5067 }, ... ],
  "basis": "Depreciation only... Excludes fuel, insurance, maintenance and tyres."
}
```

Depreciation is the largest cost of owning a used car and the one no listing
site puts a number on. `ownership` is that number and nothing else, and its
`basis` string says so and is meant to be rendered next to the figure.

## Where the data comes from, and its limits

The index carries a real but shallow history: completed sales with dates going
back a couple of months, because that is how long the crawler has been running.
**Price history cannot be backfilled** - re-stamping old observations with
today's date would invent a history that never happened - so the series only
deepens by leaving the clock running.

The single highest-value thing that would improve every number on this page is
more completed sales. Bring a Trailer publishes years of them.

## Files

- [src/analytics/stats.ts](../src/analytics/stats.ts) - summaries, histograms, fits, trends
- [src/analytics/market.ts](../src/analytics/market.ts) - the report, valuation, backtest
- [tests/analytics.test.ts](../tests/analytics.test.ts) - every honesty rule has a test
- [web/dashboard.js](../web/dashboard.js) - rendering, Chart.js vendored in `web/vendor/`
