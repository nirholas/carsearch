#!/usr/bin/env bash
# Crawls Bring a Trailer's model pages for a spread of popular makes.
#
# BaT model pages carry YEARS of completed results, not just current listings,
# which makes them by far the cheapest way to deepen the one dataset every
# statistic on the market dashboard depends on. One G-Class crawl took the model
# from 18 asking prices to 119 completed sales spanning eleven years.
#
# Sequential on purpose: the throttle is per host and every one of these hits
# the same host, so parallelism here buys nothing and earns a challenge.
set -uo pipefail
cd "$(dirname "$0")/.."

run() {
  local make="$1" models="$2"
  echo "=== $make: $models"
  timeout 600 npx tsx src/cli.ts search --make "$make" --model "$models" \
    --sources bringatrailer --concurrency 1 2>&1 \
    | grep -E "bringatrailer|kept|by source|COMPLETED" | head -12
}

run "Porsche"       "911,Cayenne,Boxster,Cayman,944,928"
run "Mercedes-Benz" "SL,E-Class,S-Class,190E"
run "BMW"           "M3,M5,3 Series,5 Series,Z3"
run "Toyota"        "Land Cruiser,Supra,4Runner,Tacoma"
run "Ford"          "Bronco,Mustang,F-150"
run "Chevrolet"     "Corvette,Camaro,Blazer"
run "Land Rover"    "Defender,Range Rover,Discovery"
run "Jeep"          "Wrangler,Grand Wagoneer,Cherokee"
run "Honda"         "Civic,S2000,NSX"
run "Nissan"        "300ZX,Skyline,240Z"
