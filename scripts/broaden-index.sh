#!/usr/bin/env bash
# Builds breadth across the newly wired sources.
#
# Each covers something the dealer sources do not: Copart states a title brand
# on every lot, Craigslist is private-party supply and states owner counts,
# Carvana and duPont carry VINs that dedupe against everything else, and the
# auction sources produce the completed sales every market statistic rests on.
#
# Sequential on purpose. These do not share a host, but running them together
# puts several browsers and a TLS client on one egress address at once, which is
# how a working source becomes a challenged one.
set -uo pipefail
cd "$(dirname "$0")/.."

run() {
  local label="$1"; shift
  echo "=== $label"
  timeout 900 npx tsx src/cli.ts search "$@" --concurrency 1 --no-enrich 2>&1 \
    | grep -E "kept |by source|integrity|FAILED" | head -6
}

# Makes come from the vocabulary, not from a list in this file.
#
# The hardcoded ten and five were a sample, and a sample is what an index that
# claims to cover the market cannot be. data/vehicle-vocab.json holds every make
# vPIC recognises; scripts/build-vocab.ts rebuilds it. The productive marques run
# first so a run killed by a Codespace recycle has spent its time where the
# inventory is, and MAKES= overrides the whole thing for a targeted pass.
LEAD="Porsche BMW Mercedes-Benz Toyota Ford Chevrolet Honda Audi Jeep Lexus Nissan Subaru Mazda Volkswagen Hyundai Kia Ram GMC Dodge Cadillac Acura Infiniti Buick Chrysler Lincoln Mitsubishi Land-Rover Volvo Jaguar Mini Tesla"

if [ -n "${MAKES:-}" ]; then
  ALL="$MAKES"
elif [ -f data/vehicle-vocab.json ]; then
  ALL="$LEAD $(node -e "
    const v = require('./data/vehicle-vocab.json');
    // Compare on alphanumerics only: the lead list hyphenates a two-word marque
    // so the shell loop can split on spaces, and 'land-rover' must still match
    // the catalogue's 'land rover' or it is crawled twice.
    const key = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const lead = new Set(process.argv[1].split(/\s+/).map(key));
    const pretty = s => s.split(/([ -])/).map(w => /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w).join('');
    // Spaces separate entries in this loop, so a two-word marque is hyphenated
    // and the adapter's own make comparison ignores punctuation anyway.
    console.log(v.makes.filter(m => !lead.has(key(m))).map(m => pretty(m).replace(/ /g, '-')).join(' '));
  " "$LEAD")"
else
  ALL="$LEAD"
  echo "no data/vehicle-vocab.json; run scripts/build-vocab.ts to reach every make" >&2
fi
echo "crawling $(echo $ALL | wc -w) makes"

# Salvage, for title-status coverage across the market rather than one marque.
for mk in $ALL; do
  run "copart $mk" --make "${mk//-/ }" --sources copart
done

# Retail inventory carrying VINs.
for mk in $ALL; do
  run "carvana $mk" --make "${mk//-/ }" --sources carvana
done

# Their URLs do not filter, so one broad pass is the whole catalogue.
run "dupont (broad)"     --sources dupontregistry
run "pcarmarket (broad)" --sources pcarmarket
run "hagerty (broad)"    --sources hagertymarketplace
