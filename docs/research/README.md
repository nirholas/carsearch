# Research carried over from the carbide prototype

Four documents from `/workspaces/carbide`, a smaller static aggregator built
independently against the same problem. Its code has been retired into this repo
(`src/core/title-risk.ts` is the only piece that survived) because carsearch
already had a better implementation of everything else it offered. The research
is the part that did not overlap.

Read them for what they measure, not for their architecture recommendations,
which are superseded by this repo.

| File | Read it when | Still current? |
|---|---|---|
| `aggregator-brief.md` | Writing an extractor. Working selectors, per-trap detail, the reachability matrix | Traps yes, source list partial |
| `oss-stack.md` | Choosing a dependency. Inventory by layer | Mostly. See the impit note below |
| `github-strategy.md` | Deciding what to open-source. Measured star ceilings per niche | Yes |
| `carbide-handoff.md` | You want the whole prototype in one pass | Superseded, kept for provenance |

## What is worth reading first

**The reachability matrix in `aggregator-brief.md`.** Site defenses key on the
TLS handshake fingerprint, not on JavaScript execution, and the matrix was
measured rather than assumed. The row that inverts intuition is Cars.com:
plain fetch 200, real headless Chromium 403, TLS-impersonating client 200. A
real browser did worse than a plain fetch, because automation-flavored TLS is a
stronger signal than headless-ness. The impersonation profile is also per-site;
Autotrader wants Chrome, its neighbours want Safari.

**Correction to `oss-stack.md`:** it recommends Python's `curl_cffi` for this.
That was written before finding that this repo already solves it in Node with
`impit` (`src/transport/tls.ts`). Read the finding, ignore the dependency
recommendation.

**The trap list.** Every entry produced plausible-looking wrong data, which is
worse than an error because nothing announces it. Several are already covered by
tests here. The two most expensive:

- `innerText` returns `""` on unrendered nodes, so use `textContent`. Cost four
  consecutive failed extractors before the cause was found.
- After any extractor change, assert the distinct-price count is near the record
  count. `19 records, 1 distinct price` is the signature of a mispairing bug and
  is invisible otherwise.

**`github-strategy.md`** is the only one with no overlap at all. Measured on the
live GitHub API: car-listings scrapers top out at 6 stars, `vehicle-listings` in
a repo name tops out at 0, and `awesome-automotive-data` returns zero repos,
while the adjacent `awesome-canbus` has 3,454 stars and
`awesome-vehicle-security` has 4,548. There are also 10,904
used-car-price-prediction repos whose best has 59 stars, because they are all the
same notebook against the same stale Kaggle CSV. This repo has live multi-source
listings with real sold comps, which is the input none of them have.

## What did not come across, and why

The carbide corpus (2,118 listings, 169 sold) was **not** imported. All ten of
its sources are already wired here, its rows carry no VIN and no title fields,
and merging them would add low-quality duplicates to an index that already holds
five times as many rows from the same places.
