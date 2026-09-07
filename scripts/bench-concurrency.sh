#!/usr/bin/env bash
# Measures whether crawling sources in parallel actually helps.
#
# Same query, same sources, same machine, only the concurrency differs. Run
# serially first so the parallel run cannot benefit from a warm DNS or TLS
# cache that the serial one paid for.
set -u
cd "$(dirname "$0")/.."
Q="--make porsche --model macan --sources carmax,bringatrailer,carsandbids --max-price 40000"

for c in 1 3; do
  rm -f "data/bench-$c.db"*
  start=$(date +%s)
  timeout 600 npx tsx src/cli.ts search $Q --concurrency "$c" --db "data/bench-$c.db" --no-enrich > "/tmp/bench-$c.log" 2>&1
  end=$(date +%s)
  kept=$(grep -oP 'kept\s+\K\d+' "/tmp/bench-$c.log" | head -1)
  echo "concurrency=$c  wall=$((end-start))s  kept=${kept:-0}"
  grep -E "returned|FAILED" "/tmp/bench-$c.log" | sed 's/^/    /'
done
