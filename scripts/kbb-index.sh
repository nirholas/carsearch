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

# Makes come from the vocabulary, not from a list in this file.
#
# The hardcoded list held 28 marques and did not include McLaren, which was
# already in the index from another source: a crawl script that names its own
# makes drifts from the catalogue the moment either changes. data/vehicle-vocab.json
# is built from the free NHTSA vPIC catalogue by scripts/build-vocab.ts and
# carries every make vPIC recognises, so pointing at it is what "all makes"
# actually means.
#
# Newline separated, because half these names contain a space or a hyphen that
# must survive intact: the adapter compares each record's own make against the
# requested one, and "Mercedes Benz" is not "Mercedes-Benz".
#
# Override for a targeted pass:  MAKES="Porsche
# BMW" ./scripts/kbb-index.sh
#
# The productive marques are crawled FIRST. vPIC lists hundreds of kit-car and
# coachbuilder names that will return nothing, and a run that dies on a recycled
# Codespace should have spent its time on the makes that carry inventory.
LEAD="Porsche
BMW
Mercedes-Benz
Audi
Toyota
Honda
Ford
Chevrolet
Lexus
Jeep
Nissan
Subaru
Mazda
Volkswagen
Hyundai
Kia
Ram
GMC
Dodge
Cadillac
Acura
Infiniti
Buick
Chrysler
Lincoln
Mitsubishi
Land Rover
Volvo
Jaguar
Mini
Tesla
Rivian
Lucid
Genesis
Alfa Romeo
Maserati
Ferrari
Lamborghini
McLaren
Aston Martin
Bentley
Rolls-Royce
Bugatti
Lotus
Polestar
Fiat"

if [ -n "${MAKES:-}" ]; then
  :
elif [ -f data/vehicle-vocab.json ]; then
  REST=$(node -e "
    const v = require('./data/vehicle-vocab.json');
    const lead = new Set(process.argv[1].split('\n').map(s => s.trim().toLowerCase()));
    const pretty = s => s.split(/([ -])/).map(w => /^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w).join('');
    console.log(v.makes.filter(m => !lead.has(m)).map(pretty).join('\n'));
  " "$LEAD")
  MAKES="$LEAD
$REST"
  echo "makes: $(echo "$LEAD" | grep -c .) known-productive + $(echo "$REST" | grep -c .) from the vPIC catalogue"
else
  MAKES="$LEAD"
  echo "no data/vehicle-vocab.json; run scripts/build-vocab.ts to reach every make" >&2
fi

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
