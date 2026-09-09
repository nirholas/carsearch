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
stronger signal than headless-ness. The impersonation profile is also per-site.

**Correction, measured 2026-09-09: Autotrader is not reachable under any
profile.** Both carbide documents record it as a 200 under `chrome124` and read
that as success. The 200 is the block: 3,761 bytes, a reCAPTCHA, zero JSON-LD,
zero prices, and a body that reads "Autotrader - page unavailable". A 200 with no
content is the most deceptive refusal there is, because every status check
passes. Do not write the extractor those docs put at priority two. The same
inventory is reachable through Kelley Blue Book, which is Cox Automotive too and
is wired here (`src/sources/kbb.ts`).

**And the profile really is per-site, which cost us a source.** Hemmings was
recorded blocked to all three transports on the strength of two aliases,
`chrome` and `firefox`, both 403. `firefox133` answers 200 with 692KB and 51
prices. The alias resolves to a build old enough to be fingerprinted. `PROFILES`
in `src/transport/tls.ts` now covers fingerprint families rather than aliases.

**Partial correction to `oss-stack.md`:** it recommends Python's `curl_cffi`.
This repo solves the same problem in Node with `impit` (`src/transport/tls.ts`),
so take the finding and not the dependency. With one real caveat: impit ships 13
Chrome, 5 Firefox and 4 okhttp profiles and **no Safari at any version**, and
carbide reached AutoNation with `safari17_0`. All eleven profiles available here
still get 403 from it. So impit is not a strict superset of curl_cffi, and
AutoNation is blocked by our toolchain rather than by the site.

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

## The corpus: already imported, before this doc was written

An earlier draft of this file said the carbide corpus was not imported. It was,
by `scripts/import-carbide.ts`, and the evidence is a source id: `somo` maps to
`sothebysmotorsport`, a string that appears in exactly one file in this entire
repo (that script), in no adapter and in no registry entry. Production holds
exactly 5 rows under it. Carbide holds exactly 5. The same match holds for
Hemmings (26 and 26) and PrivateAuto (20 and 20), neither of which has an adapter
here and both of which the registry recorded as unreachable.

So do not re-run the import expecting new rows. It went through the same
normalization, plausibility and dedupe path as a live crawl, which is why those
rows carry this repo's facets rather than carbide's flat shape.
