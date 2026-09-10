#!/usr/bin/env bash
# Every make, every year, from 1900 to next model year.
#
# The reason this exists, and why a plain per-make crawl is not enough: every
# source caps its result set, and the cap alone decides what comes back. What
# comes back is always the newest. Measured on Kelley Blue Book, an unfiltered
# Porsche query returns 350 cars of which ONE predates 2000; the same query with
# endYear=1989 returns 66 of which 54 do. The old inventory is there and simply
# cannot be reached without asking for it by year.
#
# So the unit of work is (make, year band), not (make). Bands are wide where
# supply is thin and narrow where it is dense, so no single query hits the cap
# and silently drops the rest.
#
# Sequential on purpose. These all hit one host over one TLS client, and running
# them together is how a working source becomes a challenged one.
set -uo pipefail
cd "$(dirname "$0")/.."

MAKES_FILE=${MAKES_FILE:-data/makes.txt}
STATE=${STATE:-data/full-index-done.txt}
LOG=${LOG:-data/full-index.log}
SOURCES=${SOURCES:-kbb}
PER_QUERY_TIMEOUT=${PER_QUERY_TIMEOUT:-420}

# Pre-war and vintage supply is a rounding error next to the modern market, so
# those bands are wide. 2015 onward is where the volume is, so those are narrow.
BANDS=${BANDS:-"1900:1969
1970:1989
1990:1999
2000:2009
2010:2014
2015:2019
2020:2027"}

mkdir -p "$(dirname "$STATE")"
touch "$STATE"

# Derived, not committed: data/ is gitignored, and a checked-in copy would rot
# the moment a marque is added to the MAKES table it comes from.
if [ ! -s "$MAKES_FILE" ]; then
  echo "deriving makes from src/core/normalize.ts"
  npx tsx scripts/list-makes.mts > "$MAKES_FILE" || { echo "could not derive makes"; exit 1; }
fi
[ -s "$MAKES_FILE" ] || { echo "no makes file at $MAKES_FILE"; exit 1; }

total=$(( $(grep -c . "$MAKES_FILE") * $(echo "$BANDS" | grep -c .) ))
echo "resuming: $(grep -c . "$STATE") of $total (make, band) pairs done" | tee -a "$LOG"

while IFS= read -r mk; do
  [ -z "$mk" ] && continue
  while IFS= read -r band; do
    [ -z "$band" ] && continue
    lo=${band%%:*}; hi=${band##*:}
    key="$mk|$lo-$hi"
    grep -qxF "$key" "$STATE" && continue

    printf '=== %s %s-%s\n' "$mk" "$lo" "$hi" | tee -a "$LOG"
    if out=$(timeout "$PER_QUERY_TIMEOUT" npx tsx src/cli.ts search \
               --make "$mk" --min-year "$lo" --max-year "$hi" \
               --sources "$SOURCES" --no-enrich --concurrency 1 2>&1); then
      echo "$out" | grep -E "^kbb |kept |integrity" | head -3 | tee -a "$LOG"
      # Recorded done on a clean exit even when it returned nothing: a make with
      # no 1950s inventory is a fact about the market, not a failure, and
      # retrying it forever would never finish. Only a crash or a timeout is
      # left open, because only those might succeed next time.
      printf '%s\n' "$key" >> "$STATE"
    else
      echo "    FAILED or timed out, left open for retry" | tee -a "$LOG"
    fi
    sleep 3
  done <<< "$BANDS"
done < "$MAKES_FILE"

echo "complete: $(grep -c . "$STATE") of $total pairs" | tee -a "$LOG"
