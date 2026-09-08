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

while IFS= read -r mk; do
  [ -z "$mk" ] && continue
  echo "=== kbb $mk"
  timeout 600 npx tsx src/cli.ts search --make "$mk" --sources kbb --no-enrich --concurrency 1 2>&1 \
    | grep -E "^kbb |kept |integrity|FAILED" | head -4
  sleep 4
done <<< "$MAKES"
