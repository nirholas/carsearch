#!/usr/bin/env bash
# Builds index breadth from Kelley Blue Book.
#
# KBB earns its own script because it is the only source that publishes vehicle
# history flags and retrospective price history on the search page. Every other
# source leaves `owners`, `accidents` and any price older than our first crawl
# permanently null, so a pass here raises coverage on three fields at once
# across whatever marque it is pointed at.
#
# Sequential on purpose: these all hit one host over one TLS client, and running
# them together is how a working source becomes a challenged one.
set -uo pipefail
cd "$(dirname "$0")/.."

# Newline separated, because half these makes contain a space or a hyphen that
# must survive intact: the adapter compares each record's own make against the
# requested one, and "Mercedes Benz" is not "Mercedes-Benz".
MAKES=${MAKES:-"Porsche
BMW
Mercedes-Benz
Audi
Lexus
Toyota
Honda
Ford
Chevrolet
Jeep
Subaru
Mazda
Nissan
Volkswagen
Acura
Land Rover
Volvo
Tesla
Ferrari
Lamborghini
Aston Martin
Bentley
Rolls-Royce
Maserati
Alfa Romeo
Genesis
Rivian
Lucid"}

# Resume state. A full pass is roughly three quarters of an hour and this
# Codespace recycles without warning, which killed a run at make 4 of 28 and
# took its /tmp log with it. Completed makes are recorded here so a restart
# picks up where it stopped instead of re-crawling from Porsche every time.
STATE=${STATE:-data/kbb-index-done.txt}
LOG=${LOG:-data/kbb-index.log}
mkdir -p "$(dirname "$STATE")"
touch "$STATE"

: > "$LOG"
echo "resuming: $(wc -l < "$STATE") make(s) already done" | tee -a "$LOG"

while IFS= read -r mk; do
  [ -z "$mk" ] && continue
  if grep -qxF "$mk" "$STATE"; then
    echo "=== kbb $mk (done, skipping)" | tee -a "$LOG"
    continue
  fi
  echo "=== kbb $mk" | tee -a "$LOG"
  # A make counts as done only when the crawl exits clean AND the adapter
  # reported on-make rows. A timeout or an empty pass is left unrecorded so the
  # next run retries it rather than silently skipping a gap in the index.
  if out=$(timeout 600 npx tsx src/cli.ts search --make "$mk" --sources kbb --no-enrich --concurrency 1 2>&1); then
    echo "$out" | grep -E "^kbb |kept |integrity|FAILED" | head -4 | tee -a "$LOG"
    if echo "$out" | grep -qE "^kbb .* [1-9][0-9]* on-make"; then
      printf '%s\n' "$mk" >> "$STATE"
    else
      echo "    no on-make rows, leaving unrecorded for retry" | tee -a "$LOG"
    fi
  else
    echo "    FAILED or timed out, leaving unrecorded for retry" | tee -a "$LOG"
  fi
  sleep 4
done <<< "$MAKES"

echo "complete: $(wc -l < "$STATE") of $(echo "$MAKES" | grep -c .) makes" | tee -a "$LOG"
